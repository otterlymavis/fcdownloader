package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const healthURL = "http://127.0.0.1:8765/health"

var (
	user32         = syscall.NewLazyDLL("user32.dll")
	procMessageBox = user32.NewProc("MessageBoxW")
)

func main() {
	quiet := false
	for _, arg := range os.Args[1:] {
		if strings.EqualFold(arg, "--quiet") || strings.HasPrefix(strings.ToLower(arg), "fcdownloader-companion://") {
			quiet = true
		}
	}

	if healthy() {
		if !quiet {
			message("FCDownloader Companion NoBrowser", "Helper is already running on 127.0.0.1:8765.")
		}
		return
	}

	if err := startHelper(); err != nil {
		message("FCDownloader Companion NoBrowser", fmt.Sprintf("Could not start helper:\n%s", err))
		os.Exit(1)
	}

	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)
		if healthy() {
			if !quiet {
				message("FCDownloader Companion NoBrowser", "Helper is ready on 127.0.0.1:8765.")
			}
			return
		}
	}

	message("FCDownloader Companion NoBrowser", "Helper was started, but it did not become ready in time.")
	os.Exit(1)
}

func startHelper() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	helper := filepath.Join(filepath.Dir(exe), "fcdownloader-local-helper.exe")
	if _, err := os.Stat(helper); err != nil {
		return err
	}

	cmd := exec.Command(helper)
	cmd.Dir = filepath.Dir(exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
	return cmd.Start()
}

func healthy() bool {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(healthURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func message(title, body string) {
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	bodyPtr, _ := syscall.UTF16PtrFromString(body)
	procMessageBox.Call(0, uintptr(unsafe.Pointer(bodyPtr)), uintptr(unsafe.Pointer(titlePtr)), 0)
}
