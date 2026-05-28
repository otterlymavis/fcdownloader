package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	healthURL      = "http://127.0.0.1:8765/health"
	ensureToolsURL = "http://127.0.0.1:8765/tools/ensure"
	progressURL    = "http://127.0.0.1:8765/tools/progress"

	wmDestroy = 0x0002
	wmCommand = 0x0111
	wmUser    = 0x0400
	wmTray    = wmUser + 1

	wmRButtonUp     = 0x0205
	wmLButtonDblClk = 0x0203

	nimAdd    = 0x00000000
	nimModify = 0x00000001
	nimDelete = 0x00000002

	nifMessage = 0x00000001
	nifIcon    = 0x00000002
	nifTip     = 0x00000004

	idStart       = 1001
	idStop        = 1002
	idStatus      = 1003
	idLog         = 1004
	idQuit        = 1005
	idEnsureTools = 1006
	idCache       = 1007
	idRunAtLogin  = 1008
	idConfig      = 1009
)

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	user32               = syscall.NewLazyDLL("user32.dll")
	shell32              = syscall.NewLazyDLL("shell32.dll")
	procGetModuleHandle  = kernel32.NewProc("GetModuleHandleW")
	procRegisterClassEx  = user32.NewProc("RegisterClassExW")
	procCreateWindowEx   = user32.NewProc("CreateWindowExW")
	procDefWindowProc    = user32.NewProc("DefWindowProcW")
	procLoadIcon         = user32.NewProc("LoadIconW")
	procDestroyWindow    = user32.NewProc("DestroyWindow")
	procPostQuitMessage  = user32.NewProc("PostQuitMessage")
	procGetMessage       = user32.NewProc("GetMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessage  = user32.NewProc("DispatchMessageW")
	procCreatePopupMenu  = user32.NewProc("CreatePopupMenu")
	procAppendMenu       = user32.NewProc("AppendMenuW")
	procDestroyMenu      = user32.NewProc("DestroyMenu")
	procSetForeground    = user32.NewProc("SetForegroundWindow")
	procTrackPopupMenu   = user32.NewProc("TrackPopupMenu")
	procGetCursorPos     = user32.NewProc("GetCursorPos")
	procMessageBox       = user32.NewProc("MessageBoxW")
	procShellNotifyIcon  = shell32.NewProc("Shell_NotifyIconW")
	procShellExecute     = shell32.NewProc("ShellExecuteW")
	helperProcess        *exec.Cmd
	helperLog            *os.File
	windowHandle         uintptr
)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type msg struct {
	HWnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
}

type point struct {
	X int32
	Y int32
}

type notifyIconData struct {
	Size             uint32
	HWnd             uintptr
	ID               uint32
	Flags            uint32
	CallbackMessage  uint32
	Icon             uintptr
	Tip              [128]uint16
	State            uint32
	StateMask        uint32
	Info             [256]uint16
	TimeoutOrVersion uint32
	InfoTitle        [64]uint16
	InfoFlags        uint32
	GuidItem         [16]byte
	BalloonIcon      uintptr
}

type healthInfo struct {
	OK            bool         `json:"ok"`
	Version       string       `json:"version"`
	YtDlpVersion  string       `json:"ytDlpVersion"`
	FFmpegVersion string       `json:"ffmpegVersion"`
	Tools         []toolStatus `json:"tools"`
}

type toolStatus struct {
	Name      string `json:"name"`
	Filename  string `json:"filename"`
	Installed bool   `json:"installed"`
	Verified  bool   `json:"verified"`
	Pinned    bool   `json:"pinned"`
}

type progressResponse struct {
	OK       bool          `json:"ok"`
	Progress progressState `json:"progress"`
}

type progressState struct {
	Active     bool   `json:"active"`
	Tool       string `json:"tool"`
	Downloaded int64  `json:"downloaded"`
	Total      int64  `json:"total"`
	Message    string `json:"message"`
	Error      string `json:"error"`
}

func main() {
	trayLog("tray starting: args=%s", strings.Join(os.Args[1:], " "))
	if handleCommandLine() {
		trayLog("handled command line")
		return
	}
	runtime.LockOSThread()
	hwnd := createWindow()
	windowHandle = hwnd
	trayLog("window created")
	startHelper()
	addTray(hwnd)
	trayLog("tray icon added")
	messageLoop()
}

func createWindow() uintptr {
	className, _ := syscall.UTF16PtrFromString("FCDownloaderNoBrowserTray")
	hinst, _, _ := procGetModuleHandle.Call(0)
	wndproc := syscall.NewCallback(windowProc)
	wc := wndClassEx{
		Size:      uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:   wndproc,
		Instance:  hinst,
		ClassName: className,
	}
	procRegisterClassEx.Call(uintptr(unsafe.Pointer(&wc)))
	hwnd, _, _ := procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(className)), 0, 0, 0, 0, 0, 0, 0, hinst, 0)
	if hwnd == 0 {
		panic("could not create tray window")
	}
	return hwnd
}

func addTray(hwnd uintptr) {
	icon, _, _ := procLoadIcon.Call(0, 32512)
	nid := notifyIconData{
		Size:            uint32(unsafe.Sizeof(notifyIconData{})),
		HWnd:            hwnd,
		ID:              1,
		Flags:           nifMessage | nifIcon | nifTip,
		CallbackMessage: wmTray,
		Icon:            icon,
	}
	copy(nid.Tip[:], syscall.StringToUTF16("FCDownloader Companion"))
	procShellNotifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(&nid)))
	updateTray()
}

func updateTray() {
	if windowHandle == 0 {
		return
	}
	icon, _, _ := procLoadIcon.Call(0, 32512)
	status := "Stopped"
	if info, ok := fetchHealth(); ok && info.OK {
		status = "Ready - " + toolsSummary(info.Tools)
	} else if helperProcess != nil {
		status = "Starting"
	}
	nid := notifyIconData{
		Size:            uint32(unsafe.Sizeof(notifyIconData{})),
		HWnd:            windowHandle,
		ID:              1,
		Flags:           nifMessage | nifIcon | nifTip,
		CallbackMessage: wmTray,
		Icon:            icon,
	}
	copy(nid.Tip[:], syscall.StringToUTF16("FCDownloader Companion: "+status))
	procShellNotifyIcon.Call(nimModify, uintptr(unsafe.Pointer(&nid)))
}

func updateTrayTip(text string) {
	if windowHandle == 0 {
		return
	}
	icon, _, _ := procLoadIcon.Call(0, 32512)
	nid := notifyIconData{
		Size:            uint32(unsafe.Sizeof(notifyIconData{})),
		HWnd:            windowHandle,
		ID:              1,
		Flags:           nifMessage | nifIcon | nifTip,
		CallbackMessage: wmTray,
		Icon:            icon,
	}
	copy(nid.Tip[:], syscall.StringToUTF16("FCDownloader Companion: "+text))
	procShellNotifyIcon.Call(nimModify, uintptr(unsafe.Pointer(&nid)))
}

func deleteTray(hwnd uintptr) {
	nid := notifyIconData{Size: uint32(unsafe.Sizeof(notifyIconData{})), HWnd: hwnd, ID: 1}
	procShellNotifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(&nid)))
}

func windowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmTray:
		if lParam == wmRButtonUp {
			showMenu(hwnd)
			return 0
		}
		if lParam == wmLButtonDblClk {
			showStatus()
			return 0
		}
	case wmCommand:
		switch uint32(wParam & 0xffff) {
		case idStart:
			startHelper()
		case idStop:
			stopHelper()
		case idStatus:
			showStatus()
		case idLog:
			openLog()
		case idEnsureTools:
			ensureTools()
		case idCache:
			openCache()
		case idRunAtLogin:
			toggleRunAtLogin()
		case idConfig:
			openConfig()
		case idQuit:
			procDestroyWindow.Call(hwnd)
		}
		return 0
	case wmDestroy:
		deleteTray(hwnd)
		stopHelper()
		procPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := procDefWindowProc.Call(hwnd, uintptr(message), wParam, lParam)
	return ret
}

func showMenu(hwnd uintptr) {
	menu, _, _ := procCreatePopupMenu.Call()
	appendMenu(menu, idStart, "Start helper")
	appendMenu(menu, idStop, "Stop helper")
	appendMenu(menu, idStatus, "Status")
	appendMenu(menu, idEnsureTools, "Install/update video tools")
	appendMenu(menu, idCache, "Open cache folder")
	appendMenu(menu, idConfig, "Open mirror config")
	appendMenu(menu, idRunAtLogin, runAtLoginLabel())
	appendMenu(menu, idLog, "Open log")
	appendMenu(menu, idQuit, "Quit")
	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	procSetForeground.Call(hwnd)
	procTrackPopupMenu.Call(menu, 0, uintptr(pt.X), uintptr(pt.Y), 0, hwnd, 0)
	procDestroyMenu.Call(menu)
}

func appendMenu(menu uintptr, id uintptr, label string) {
	text, _ := syscall.UTF16PtrFromString(label)
	procAppendMenu.Call(menu, 0, id, uintptr(unsafe.Pointer(text)))
}

func messageLoop() {
	var m msg
	for {
		ret, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(ret) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessage.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func startHelper() {
	trayLog("start requested")
	if healthy() {
		trayLog("helper already healthy")
		updateTray()
		return
	}
	if helperProcess != nil && helperProcess.Process != nil {
		trayLog("helper process already tracked")
		updateTray()
		return
	}
	exe, err := os.Executable()
	if err != nil {
		trayLog("executable lookup failed: %v", err)
		showError(err)
		return
	}
	helper := filepath.Join(filepath.Dir(exe), "FCDownloaderNativeHelper.exe")
	trayLog("starting helper: %s", helper)
	logFile, err := openLogFile()
	if err != nil {
		trayLog("helper log open failed: %v", err)
		showError(err)
		return
	}
	cmd := exec.Command(helper)
	cmd.Dir = filepath.Dir(exe)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP, HideWindow: true}
	if err := cmd.Start(); err != nil {
		trayLog("helper start failed: %v", err)
		showError(err)
		return
	}
	trayLog("helper process started: %d", cmd.Process.Pid)
	helperProcess = cmd
	helperLog = logFile
	go func() {
		err := cmd.Wait()
		trayLog("helper process exited: %v", err)
		helperProcess = nil
		if helperLog != nil {
			_ = helperLog.Close()
			helperLog = nil
		}
	}()
	updateTray()
}

func stopHelper() {
	if helperProcess != nil && helperProcess.Process != nil {
		_ = helperProcess.Process.Kill()
		helperProcess = nil
	}
	if helperLog != nil {
		_ = helperLog.Close()
		helperLog = nil
	}
	updateTray()
}

func healthy() bool {
	_, ok := fetchHealth()
	return ok
}

func fetchHealth() (healthInfo, bool) {
	client := &http.Client{Timeout: 1200 * time.Millisecond}
	resp, err := client.Get(healthURL)
	if err != nil {
		return healthInfo{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return healthInfo{}, false
	}
	var info healthInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return healthInfo{OK: true}, true
	}
	return info, true
}

func fetchProgress() (progressState, bool) {
	client := &http.Client{Timeout: 1200 * time.Millisecond}
	resp, err := client.Get(progressURL)
	if err != nil {
		return progressState{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return progressState{}, false
	}
	var data progressResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return progressState{}, false
	}
	return data.Progress, data.OK
}

func showStatus() {
	status := "Stopped"
	if info, ok := fetchHealth(); ok && info.OK {
		lines := []string{
			"Ready on 127.0.0.1:8765",
			"Helper: " + info.Version,
			"yt-dlp: " + info.YtDlpVersion,
			"ffmpeg: " + info.FFmpegVersion,
			"Tools: " + toolsSummary(info.Tools),
		}
		status = strings.Join(lines, "\r\n")
	} else if helperProcess != nil {
		status = "Starting\r\nVideo tools may download on first use."
	}
	message("FCDownloader Companion", status)
}

func ensureTools() {
	startHelper()
	go func() {
		client := &http.Client{Timeout: 10 * time.Minute}
		done := make(chan error, 1)
		go func() {
			resp, err := client.Get(ensureToolsURL)
			if err != nil {
				done <- err
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				done <- fmt.Errorf("tool install failed: HTTP %d", resp.StatusCode)
				return
			}
			done <- nil
		}()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case err := <-done:
				updateTray()
				if err != nil {
					showError(err)
				} else {
					message("FCDownloader Companion", "Video tools are installed and ready.")
				}
				return
			case <-ticker.C:
				if progress, ok := fetchProgress(); ok {
					updateTrayTip("Installing " + progressText(progress))
				}
			}
		}
	}()
	message("FCDownloader Companion", "Installing video tools in the background. Hover the tray icon for progress.")
}

func openLog() {
	path := logPath()
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		_ = os.WriteFile(path, []byte("FCDownloader native helper log\n"), 0o644)
	}
	op, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(path)
	procShellExecute.Call(0, uintptr(unsafe.Pointer(op)), uintptr(unsafe.Pointer(file)), 0, 0, 1)
}

func openCache() {
	_ = os.MkdirAll(cacheRoot(), 0o755)
	op, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(cacheRoot())
	procShellExecute.Call(0, uintptr(unsafe.Pointer(op)), uintptr(unsafe.Pointer(file)), 0, 0, 1)
}

func openConfig() {
	path := configPath()
	if err := writeDefaultConfig(path); err != nil {
		showError(err)
		return
	}
	op, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(path)
	procShellExecute.Call(0, uintptr(unsafe.Pointer(op)), uintptr(unsafe.Pointer(file)), 0, 0, 1)
}

func progressText(progress progressState) string {
	if progress.Tool == "" {
		return "video tools"
	}
	if progress.Total > 0 {
		pct := int(float64(progress.Downloaded) * 100 / float64(progress.Total))
		return fmt.Sprintf("%s %d%%", progress.Tool, pct)
	}
	if progress.Downloaded > 0 {
		return fmt.Sprintf("%s %.1f MB", progress.Tool, float64(progress.Downloaded)/(1024*1024))
	}
	return progress.Tool
}

func toolsSummary(tools []toolStatus) string {
	if len(tools) == 0 {
		return "tools pending"
	}
	installed := 0
	unverified := 0
	for _, tool := range tools {
		if tool.Installed {
			installed++
		}
		if tool.Installed && !tool.Verified {
			unverified++
		}
	}
	if installed == len(tools) && unverified == 0 {
		return "tools installed"
	}
	if installed == len(tools) {
		return "tools installed, verification pending"
	}
	return fmt.Sprintf("%d/%d tools installed", installed, len(tools))
}

func handleCommandLine() bool {
	for _, arg := range os.Args[1:] {
		switch strings.ToLower(arg) {
		case "--stop":
			stopListeningHelper()
			return true
		case "--status":
			if info, ok := fetchHealth(); ok && info.OK {
				message("FCDownloader Companion", "Ready on 127.0.0.1:8765\r\nTools: "+toolsSummary(info.Tools))
			} else {
				message("FCDownloader Companion", "Stopped")
			}
			return true
		case "--open-log":
			openLog()
			return true
		case "--open-cache":
			openCache()
			return true
		case "--open-config":
			openConfig()
			return true
		case "--ensure-tools":
			ensureTools()
			return true
		}
	}
	return false
}

func stopListeningHelper() {
	if !healthy() {
		return
	}
	script := `$pids = (netstat -ano | Select-String ':8765.*LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique); foreach ($pid in $pids) { Stop-Process -Id ([int]$pid) -Force }`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}

func runAtLoginLabel() string {
	if runAtLoginEnabled() {
		return "Run at login: On"
	}
	return "Run at login: Off"
}

func toggleRunAtLogin() {
	var err error
	if runAtLoginEnabled() {
		err = setRunAtLogin(false)
	} else {
		err = setRunAtLogin(true)
	}
	if err != nil {
		showError(err)
		return
	}
	message("FCDownloader Companion", runAtLoginLabel())
}

func runAtLoginEnabled() bool {
	cmd := exec.Command("reg.exe", "query", `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", "FCDownloaderCompanion")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Run() == nil
}

func setRunAtLogin(enabled bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	var cmd *exec.Cmd
	if enabled {
		cmd = exec.Command("reg.exe", "add", `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", "FCDownloaderCompanion", "/t", "REG_SZ", "/d", `"`+exe+`"`, "/f")
	} else {
		cmd = exec.Command("reg.exe", "delete", `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", "FCDownloaderCompanion", "/f")
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Run()
}

func openLogFile() (*os.File, error) {
	path := logPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
}

func logPath() string {
	return filepath.Join(cacheRoot(), "logs", "native-helper.log")
}

func trayLogPath() string {
	return filepath.Join(cacheRoot(), "logs", "tray.log")
}

func trayLog(format string, args ...interface{}) {
	path := trayLogPath()
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	line := fmt.Sprintf(time.Now().Format(time.RFC3339)+" "+format+"\n", args...)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err == nil {
		_, _ = file.WriteString(line)
		_ = file.Close()
	}
}

func configPath() string {
	return filepath.Join(cacheRoot(), "helper-config.json")
}

func writeDefaultConfig(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	body := "{\n  \"ytDlpUrl\": \"\",\n  \"ffmpegBaseUrl\": \"\"\n}\n"
	return os.WriteFile(path, []byte(body), 0o644)
}

func cacheRoot() string {
	if override := os.Getenv("FCDL_HELPER_CACHE_DIR"); override != "" {
		return override
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	return filepath.Join(base, "FCDownloader")
}

func showError(err error) {
	message("FCDownloader Companion", fmt.Sprintf("Error: %s", err))
}

func message(title, body string) {
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	bodyPtr, _ := syscall.UTF16PtrFromString(body)
	procMessageBox.Call(0, uintptr(unsafe.Pointer(bodyPtr)), uintptr(unsafe.Pointer(titlePtr)), 0)
}
