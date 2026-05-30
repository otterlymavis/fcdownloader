package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed tool_manifest.json
var toolManifestJSON []byte

const (
	host                 = "127.0.0.1"
	port                 = "8765"
	serviceVersion       = "0.3.0-go"
	apiVersion           = "v1"
	maxURLLength         = 4096
	defaultFormat        = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/best[ext=mp4]/best"
	youtubeFormat        = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/137+140/136+140/18"
	pinnedYtDlpVersion   = "2026.03.17"
	defaultYtDlpBaseURL  = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17"
	defaultFFmpegBaseURL = "https://raw.githubusercontent.com/imageio/imageio-binaries/master/ffmpeg"
	maxRequestsPerMinute = 90
)

type toolAsset struct {
	URL      string
	Filename string
	SHA256   string
}

type toolManifest struct {
	YtDlp struct {
		Version string               `json:"version"`
		BaseURL string               `json:"baseUrl"`
		Assets  map[string]toolAsset `json:"assets"`
	} `json:"ytDlp"`
	FFmpeg struct {
		BaseURL string               `json:"baseUrl"`
		Assets  map[string]toolAsset `json:"assets"`
	} `json:"ffmpeg"`
}

var toolPins = mustToolManifest()

type formatInfo struct {
	FormatID string      `json:"formatId"`
	Label    string      `json:"label"`
	Height   interface{} `json:"height"`
	Ext      interface{} `json:"ext"`
	VCodec   interface{} `json:"vcodec"`
	ACodec   interface{} `json:"acodec"`
	Filesize interface{} `json:"filesize"`
	Protocol interface{} `json:"protocol"`
}

type toolStatus struct {
	Name      string `json:"name"`
	Filename  string `json:"filename"`
	Path      string `json:"path"`
	Installed bool   `json:"installed"`
	Verified  bool   `json:"verified"`
	Pinned    bool   `json:"pinned"`
}

type helperConfig struct {
	YtDlpURL      string `json:"ytDlpUrl"`
	FFmpegBaseURL string `json:"ffmpegBaseUrl"`
}

type progressState struct {
	Active     bool   `json:"active"`
	Tool       string `json:"tool"`
	URL        string `json:"url"`
	Downloaded int64  `json:"downloaded"`
	Total      int64  `json:"total"`
	Attempt    int    `json:"attempt"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	UpdatedAt  string `json:"updatedAt"`
}

var (
	progressMu sync.Mutex
	progress   progressState
	limitMu    sync.Mutex
	limitHits  = map[string][]time.Time{}
)

func main() {
	initLog()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/tools", handleTools)
	mux.HandleFunc("/tools/ensure", handleEnsureTools)
	mux.HandleFunc("/tools/progress", handleToolsProgress)
	mux.HandleFunc("/formats", handleFormats)
	mux.HandleFunc("/download", func(w http.ResponseWriter, r *http.Request) { handleDownload(w, r, false) })
	mux.HandleFunc("/youtube-hd", func(w http.ResponseWriter, r *http.Request) { handleDownload(w, r, true) })
	mux.HandleFunc("/download/progress", handleDownloadProgress)

	server := &http.Server{
		Addr:              net.JoinHostPort(host, port),
		Handler:           cors(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	logf("FCDownloader native helper listening on http://%s:%s", host, port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logf("server stopped: %v", err)
		os.Exit(1)
	}
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !validLocalHost(r.Host) {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		if !rateLimitOK(r) {
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", allowedOrigin(r.Header.Get("Origin")))
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-FCDL-Helper-Token")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if !authorizedLocalRequest(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	ytDlpAsset, _ := platformYtDlpAsset(runtime.GOOS, runtime.GOARCH)
	ffmpegAsset, _ := platformFFmpegAsset(runtime.GOOS, runtime.GOARCH)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":         true,
		"service":    "fcdownloader-native-helper",
		"version":    serviceVersion,
		"apiVersion": apiVersion,
		"compatibility": map[string]interface{}{
			"helperApi":             apiVersion,
			"minimumExtensionBuild": "1.4.0",
			"minimumWebBuild":       "1.5.0",
		},
		"ytDlpVersion":    toolPins.YtDlp.Version,
		"ytDlpAsset":      ytDlpAsset.Filename,
		"ffmpegVersion":   ffmpegAsset.Filename,
		"cacheRoot":       cacheRoot(),
		"logPath":         logPath(),
		"toolPinning":     toolPinningStatus(ytDlpAsset, ffmpegAsset),
		"endpoints":       []string{"/health", "/tools", "/tools/ensure", "/tools/progress", "/formats", "/download", "/youtube-hd", "/download/progress"},
		"downloadedTools": downloadedTools(),
		"tools":           toolStatuses(),
		"needsSetup":      toolsNeedSetup(),
		"configPath":      configPath(),
	})
}

func handleTools(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":    true,
		"tools": toolStatuses(),
	})
}

func handleToolsProgress(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":       true,
		"progress": currentProgress(),
	})
}

func handleEnsureTools(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	if _, err := ytDlpPath(ctx); err != nil {
		logf("tool ensure failed for yt-dlp: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error(), "tool": "yt-dlp"})
		return
	}
	if _, err := ffmpegPath(ctx); err != nil {
		logf("tool ensure failed for ffmpeg: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error(), "tool": "ffmpeg"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":    true,
		"tools": toolStatuses(),
	})
}

func handleFormats(w http.ResponseWriter, r *http.Request) {
	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	logf("formats request: %s", rawURL)
	if !allowedURL(rawURL) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url must be an http(s) media page URL"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	data, err := runYtDlpJSON(ctx, rawURL)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func handleDownload(w http.ResponseWriter, r *http.Request, youtubeOnly bool) {
	q := r.URL.Query()
	rawURL := strings.TrimSpace(q.Get("url"))
	logf("download request: %s", rawURL)
	if !allowedURL(rawURL) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url must be an http(s) media page URL"})
		return
	}
	if youtubeOnly && !youtubeURL(rawURL) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url must be a YouTube URL"})
		return
	}

	// Flush headers immediately so the Chrome extension's download manager doesn't time out
	// while waiting for yt-dlp to finish downloading the video.
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Content-Disposition", `attachment; filename="fcdownloader_video.mp4"`)
	w.WriteHeader(http.StatusOK)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	filePath, cleanup, err := downloadMedia(r.Context(), rawURL, strings.TrimSpace(q.Get("format")), strings.TrimSpace(q.Get("max_height")))
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		// Headers already sent, so we can't send a JSON error payload anymore.
		// Simply aborting the connection will let the browser know the download failed.
		logf("download error: %v", err)
		return
	}

	file, err := os.Open(filePath)
	if err != nil {
		logf("failed to open downloaded file: %v", err)
		return
	}
	defer file.Close()

	io.Copy(w, file)
}

func runYtDlpJSON(ctx context.Context, rawURL string) (map[string]interface{}, error) {
	ytDlp, err := ytDlpPath(ctx)
	if err != nil {
		return nil, err
	}
	args := []string{
		"--dump-single-json",
		"--skip-download",
		"--no-warnings",
		"--js-runtimes", "node",
		"--remote-components", "ejs:github",
		rawURL,
	}
	out, err := exec.CommandContext(ctx, ytDlp, args...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("%s", tail(out))
	}

	var data map[string]interface{}
	if err := json.Unmarshal(out, &data); err != nil {
		return nil, err
	}
	rawFormats, _ := data["formats"].([]interface{})
	formats := make([]formatInfo, 0, len(rawFormats))
	for _, item := range rawFormats {
		fmtMap, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		id := stringValue(fmtMap["format_id"])
		if id == "" {
			continue
		}
		label := firstString(fmtMap["format_note"], fmtMap["resolution"])
		if label == "" {
			label = id
		}
		formats = append(formats, formatInfo{
			FormatID: id,
			Label:    label,
			Height:   fmtMap["height"],
			Ext:      fmtMap["ext"],
			VCodec:   fmtMap["vcodec"],
			ACodec:   fmtMap["acodec"],
			Filesize: firstNonNil(fmtMap["filesize"], fmtMap["filesize_approx"]),
			Protocol: fmtMap["protocol"],
		})
	}

	return map[string]interface{}{
		"ok":         true,
		"service":    "fcdownloader-native-helper",
		"extractor":  firstNonNil(data["extractor_key"], data["extractor"]),
		"title":      data["title"],
		"thumbnail":  data["thumbnail"],
		"id":         data["id"],
		"webpageUrl": firstNonNil(data["webpage_url"], rawURL),
		"duration":   data["duration"],
		"formats":    formats,
	}, nil
}

func downloadMedia(ctx context.Context, rawURL, format, maxHeight string) (string, func(), error) {
	ytDlp, err := ytDlpPath(ctx)
	if err != nil {
		return "", nil, err
	}
	ffmpeg, err := ffmpegPath(ctx)
	if err != nil {
		return "", nil, err
	}
	if format == "" {
		if regexp.MustCompile(`^\d{3,4}$`).MatchString(maxHeight) {
			format = fmt.Sprintf("bv*[height<=%s][ext=mp4]+ba[ext=m4a]/bv*[height<=%s]+ba/best[height<=%s]/best", maxHeight, maxHeight, maxHeight)
		} else if youtubeURL(rawURL) {
			format = youtubeFormat
		} else {
			format = defaultFormat
		}
	}

	tmp, err := os.MkdirTemp("", "fcdl_native_*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }

	runCtx, cancel := context.WithTimeout(ctx, time.Hour)
	defer cancel()
	args := []string{
		"-f", format,
		"--newline",
		"--merge-output-format", "mp4",
		"--remux-video", "mp4",
		"--js-runtimes", "node",
		"--remote-components", "ejs:github",
		"--ffmpeg-location", ffmpeg,
		"-o", filepath.Join(tmp, "%(title).120s-%(id)s.%(ext)s"),
		rawURL,
	}
	out, err := runYtDlpWithProgress(runCtx, ytDlp, args, rawURL)
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("%s", tail(out))
	}

	files, err := os.ReadDir(tmp)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	var candidates []string
	for _, file := range files {
		if !file.Type().IsRegular() {
			continue
		}
		candidates = append(candidates, filepath.Join(tmp, file.Name()))
	}
	sort.Slice(candidates, func(i, j int) bool {
		ai, _ := os.Stat(candidates[i])
		aj, _ := os.Stat(candidates[j])
		return ai.Size() > aj.Size()
	})
	if len(candidates) == 0 {
		cleanup()
		return "", nil, errors.New("yt-dlp produced no media file")
	}
	return candidates[0], cleanup, nil
}

func ytDlpPath(ctx context.Context) (string, error) {
	if explicit := os.Getenv("FCDL_YTDLP_EXE"); explicit != "" {
		return explicit, nil
	}
	if system, err := exec.LookPath("yt-dlp"); err == nil {
		return system, nil
	}
	asset, err := platformYtDlpAsset(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	target := filepath.Join(cacheRoot(), "bin", toolExecutableName("yt-dlp", runtime.GOOS))
	expected := envDefault("FCDL_YTDLP_SHA256", asset.SHA256)
	if cachedToolValid(target, expected) {
		return target, nil
	}
	config := readHelperConfig()
	url := envDefault("FCDL_YTDLP_URL", firstString(config.YtDlpURL, asset.URL))
	if err := downloadFile(ctx, "yt-dlp", url, target, ""); err != nil {
		return "", err
	}
	if err := verifySHA256(target, expected); err != nil {
		_ = os.Remove(target)
		return "", err
	}
	return target, nil
}

func ffmpegPath(ctx context.Context) (string, error) {
	if explicit := os.Getenv("FCDL_FFMPEG_EXE"); explicit != "" {
		return explicit, nil
	}
	if explicit := os.Getenv("IMAGEIO_FFMPEG_EXE"); explicit != "" {
		return explicit, nil
	}
	if system, err := exec.LookPath("ffmpeg"); err == nil {
		return system, nil
	}
	asset, err := platformFFmpegAsset(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	target := filepath.Join(cacheRoot(), "ffmpeg", asset.Filename)
	expected := envDefault("FCDL_FFMPEG_SHA256", asset.SHA256)
	if cachedToolValid(target, expected) {
		return target, nil
	}
	config := readHelperConfig()
	url := asset.URL
	if override := os.Getenv("FCDL_FFMPEG_BASE_URL"); override != "" {
		url = strings.TrimRight(override, "/") + "/" + asset.Filename
	} else if config.FFmpegBaseURL != "" {
		url = strings.TrimRight(config.FFmpegBaseURL, "/") + "/" + asset.Filename
	}
	if err := downloadFile(ctx, "ffmpeg", url, target, expected); err != nil {
		return "", err
	}
	return target, nil
}

func mustToolManifest() toolManifest {
	var manifest toolManifest
	if err := json.Unmarshal(toolManifestJSON, &manifest); err != nil {
		panic(err)
	}
	return manifest
}

func platformYtDlpAsset(goos, goarch string) (toolAsset, error) {
	asset, ok := toolPins.YtDlp.Assets[goos+"-"+goarch]
	if !ok {
		return toolAsset{}, fmt.Errorf("no yt-dlp download is configured for %s-%s", goos, goarch)
	}
	baseURL := toolPins.YtDlp.BaseURL
	if baseURL == "" {
		baseURL = defaultYtDlpBaseURL
	}
	asset.URL = strings.TrimRight(baseURL, "/") + "/" + asset.Filename
	return asset, nil
}

func platformFFmpegAsset(goos, goarch string) (toolAsset, error) {
	asset, ok := toolPins.FFmpeg.Assets[goos+"-"+goarch]
	if !ok {
		return toolAsset{}, fmt.Errorf("no ffmpeg download is configured for %s-%s", goos, goarch)
	}
	baseURL := toolPins.FFmpeg.BaseURL
	if baseURL == "" {
		baseURL = defaultFFmpegBaseURL
	}
	asset.URL = strings.TrimRight(baseURL, "/") + "/" + asset.Filename
	return asset, nil
}

func cachedToolValid(path, expectedSHA string) bool {
	if !executable(path) {
		return false
	}
	if expectedSHA == "" {
		return true
	}
	if err := verifySHA256(path, expectedSHA); err != nil {
		_ = os.Remove(path)
		return false
	}
	return true
}

func toolExecutableName(name, goos string) string {
	if goos == "windows" {
		return name + ".exe"
	}
	return name
}

func toolPinningStatus(ytDlpAsset, ffmpegAsset toolAsset) string {
	if ytDlpAsset.SHA256 != "" && ffmpegAsset.SHA256 != "" {
		return "yt-dlp and ffmpeg downloads are SHA-256 verified"
	}
	if ytDlpAsset.SHA256 != "" {
		return "yt-dlp downloads are SHA-256 verified; ffmpeg asset version is pinned"
	}
	return "tool asset versions are pinned"
}

func downloadFile(ctx context.Context, tool, rawURL, target, expectedSHA string) error {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		if err := downloadFileOnce(ctx, tool, rawURL, target, expectedSHA, attempt); err != nil {
			lastErr = err
			logf("download attempt %d failed for %s: %v", attempt, tool, err)
			time.Sleep(time.Duration(attempt) * time.Second)
			continue
		}
		return nil
	}
	setProgress(progressState{Tool: tool, URL: rawURL, Message: "download failed", Error: lastErr.Error()})
	return fmt.Errorf("%s download failed after retries: %w", tool, lastErr)
}

func downloadFileOnce(ctx context.Context, tool, rawURL, target, expectedSHA string, attempt int) error {
	logf("downloading %s", rawURL)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	tmp := target + ".download"
	var existing int64
	if info, err := os.Stat(tmp); err == nil {
		existing = info.Size()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	if existing > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", existing))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("download failed: %s", resp.Status)
	}
	if existing > 0 && resp.StatusCode != http.StatusPartialContent {
		existing = 0
		_ = os.Remove(tmp)
	}
	total := resp.ContentLength
	if total > 0 {
		total += existing
	}
	setProgress(progressState{Active: true, Tool: tool, URL: rawURL, Downloaded: existing, Total: total, Attempt: attempt, Message: "downloading"})
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	writer := &progressWriter{tool: tool, url: rawURL, total: total, attempt: attempt, downloaded: existing}
	if _, err = io.Copy(out, io.TeeReader(resp.Body, writer)); err != nil {
		_ = out.Close()
		return err
	}
	if err = out.Close(); err != nil {
		return err
	}
	if expectedSHA != "" {
		if err := verifySHA256(tmp, expectedSHA); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(tmp, 0o755)
	}
	if err := os.Rename(tmp, target); err != nil {
		return err
	}
	setProgress(progressState{Tool: tool, URL: rawURL, Downloaded: writer.downloaded, Total: total, Attempt: attempt, Message: "complete"})
	return nil
}

type progressWriter struct {
	tool       string
	url        string
	total      int64
	attempt    int
	downloaded int64
	lastUpdate time.Time
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n := len(p)
	w.downloaded += int64(n)
	if time.Since(w.lastUpdate) > 500*time.Millisecond {
		w.lastUpdate = time.Now()
		setProgress(progressState{Active: true, Tool: w.tool, URL: w.url, Downloaded: w.downloaded, Total: w.total, Attempt: w.attempt, Message: "downloading"})
	}
	return n, nil
}

func setProgress(state progressState) {
	progressMu.Lock()
	defer progressMu.Unlock()
	state.UpdatedAt = time.Now().Format(time.RFC3339)
	progress = state
}

func currentProgress() progressState {
	progressMu.Lock()
	defer progressMu.Unlock()
	return progress
}

var logFile *os.File

func initLog() {
	path := logPath()
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err == nil {
		logFile = file
	}
}

func logPath() string {
	return filepath.Join(cacheRoot(), "logs", "native-helper.log")
}

func logf(format string, args ...interface{}) {
	line := fmt.Sprintf(time.Now().Format(time.RFC3339)+" "+format+"\n", args...)
	fmt.Print(line)
	if logFile != nil {
		_, _ = logFile.WriteString(line)
	}
}

func downloadedTools() map[string]bool {
	ytDlpAsset, _ := platformYtDlpAsset(runtime.GOOS, runtime.GOARCH)
	ffmpegAsset, _ := platformFFmpegAsset(runtime.GOOS, runtime.GOARCH)
	return map[string]bool{
		"yt-dlp": ytDlpAsset.Filename != "" && executable(filepath.Join(cacheRoot(), "bin", toolExecutableName("yt-dlp", runtime.GOOS))),
		"ffmpeg": ffmpegAsset.Filename != "" && executable(filepath.Join(cacheRoot(), "ffmpeg", ffmpegAsset.Filename)),
	}
}

func toolStatuses() []toolStatus {
	ytDlpAsset, _ := platformYtDlpAsset(runtime.GOOS, runtime.GOARCH)
	ffmpegAsset, _ := platformFFmpegAsset(runtime.GOOS, runtime.GOARCH)
	return []toolStatus{
		statusForTool("yt-dlp", filepath.Join(cacheRoot(), "bin", toolExecutableName("yt-dlp", runtime.GOOS)), ytDlpAsset),
		statusForTool("ffmpeg", filepath.Join(cacheRoot(), "ffmpeg", ffmpegAsset.Filename), ffmpegAsset),
	}
}

func toolsNeedSetup() bool {
	for _, tool := range toolStatuses() {
		if !tool.Installed || !tool.Verified {
			return true
		}
	}
	return false
}

func statusForTool(name, path string, asset toolAsset) toolStatus {
	status := toolStatus{
		Name:      name,
		Filename:  asset.Filename,
		Path:      path,
		Installed: executable(path),
		Verified:  asset.SHA256 == "",
		Pinned:    asset.Filename != "",
	}
	if status.Installed && asset.SHA256 != "" {
		status.Verified = verifySHA256(path, asset.SHA256) == nil
	}
	return status
}

func verifySHA256(path, expected string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("checksum mismatch for %s", filepath.Base(path))
	}
	return nil
}

func cacheRoot() string {
	if override := os.Getenv("FCDL_HELPER_CACHE_DIR"); override != "" {
		return override
	}
	if runtime.GOOS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
		}
		return filepath.Join(base, "FCDownloader")
	}
	if runtime.GOOS == "darwin" {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Caches", "FCDownloader")
	}
	if xdg := os.Getenv("XDG_CACHE_HOME"); xdg != "" {
		return filepath.Join(xdg, "fcdownloader")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cache", "fcdownloader")
}

func configPath() string {
	return filepath.Join(cacheRoot(), "helper-config.json")
}

func readHelperConfig() helperConfig {
	data, err := os.ReadFile(configPath())
	if err != nil {
		return helperConfig{}
	}
	var config helperConfig
	_ = json.Unmarshal(data, &config)
	config.YtDlpURL = strings.TrimSpace(config.YtDlpURL)
	config.FFmpegBaseURL = strings.TrimSpace(config.FFmpegBaseURL)
	return config
}

func writeDefaultHelperConfig(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	data := []byte("{\n  \"ytDlpUrl\": \"\",\n  \"ffmpegBaseUrl\": \"\"\n}\n")
	return os.WriteFile(path, data, 0o644)
}

func allowedURL(value string) bool {
	if value == "" || len(value) > maxURLLength {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host != "" && host != "localhost" && host != "127.0.0.1" && host != "::1"
}

func validLocalHost(hostHeader string) bool {
	hostOnly := hostHeader
	if host, _, err := net.SplitHostPort(hostHeader); err == nil {
		hostOnly = host
	}
	hostOnly = strings.Trim(hostOnly, "[]")
	return hostOnly == "" || hostOnly == host || hostOnly == "localhost"
}

func rateLimitOK(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	now := time.Now()
	cutoff := now.Add(-time.Minute)
	limitMu.Lock()
	defer limitMu.Unlock()
	hits := limitHits[host]
	kept := hits[:0]
	for _, hit := range hits {
		if hit.After(cutoff) {
			kept = append(kept, hit)
		}
	}
	if len(kept) >= maxRequestsPerMinute {
		limitHits[host] = kept
		return false
	}
	limitHits[host] = append(kept, now)
	return true
}

func allowedOrigin(origin string) string {
	if origin == "" {
		return "*"
	}
	allowed := strings.TrimSpace(os.Getenv("FCDL_ALLOWED_ORIGINS"))
	if allowed == "" {
		return "*"
	}
	for _, item := range strings.Split(allowed, ",") {
		if strings.EqualFold(strings.TrimSpace(item), origin) {
			return origin
		}
	}
	return "null"
}

func authorizedLocalRequest(r *http.Request) bool {
	token := os.Getenv("FCDL_HELPER_TOKEN")
	if token == "" {
		return true
	}
	return r.Header.Get("X-FCDL-Helper-Token") == token || r.URL.Query().Get("token") == token
}

func youtubeURL(value string) bool {
	parsed, _ := url.Parse(value)
	host := strings.ToLower(parsed.Hostname())
	return host == "youtu.be" || strings.HasSuffix(host, "youtube.com") || strings.HasSuffix(host, "youtube-nocookie.com")
}

func executable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func tail(data []byte) string {
	text := strings.TrimSpace(string(data))
	if len(text) > 2000 {
		return text[len(text)-2000:]
	}
	if text == "" {
		return "command failed"
	}
	return text
}

func safeName(value string) string {
	var out strings.Builder
	for _, r := range value {
		if r < 128 && ((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune(" ._-()", r)) {
			out.WriteRune(r)
		} else {
			out.WriteByte('_')
		}
	}
	text := strings.Trim(out.String(), " ._")
	if text == "" {
		return "fcdownloader-media"
	}
	if len(text) > 160 {
		return text[:160]
	}
	return text
}

func stringValue(value interface{}) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

func firstString(values ...interface{}) string {
	for _, value := range values {
		if text := stringValue(value); text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func firstNonNil(values ...interface{}) interface{} {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func envDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

type mediaProgress struct {
	URL        string  `json:"url"`
	Percent    float64 `json:"percent"`
	Speed      string  `json:"speed"`
	ETA        string  `json:"eta"`
	Status     string  `json:"status"` // "starting", "downloading", "merging", "complete", "error"
	Downloaded string  `json:"downloaded"`
	Total      string  `json:"total"`
}

var (
	mediaProgressMu sync.Mutex
	mediaDownloads  = make(map[string]*mediaProgress)
)

func setMediaProgress(url string, p *mediaProgress) {
	mediaProgressMu.Lock()
	defer mediaProgressMu.Unlock()
	mediaDownloads[url] = p
}

func getMediaProgress(url string) *mediaProgress {
	mediaProgressMu.Lock()
	defer mediaProgressMu.Unlock()
	return mediaDownloads[url]
}

func handleDownloadProgress(w http.ResponseWriter, r *http.Request) {
	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if rawURL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url parameter is required"})
		return
	}
	prog := getMediaProgress(rawURL)
	if prog == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no active download found for this url"})
		return
	}
	writeJSON(w, http.StatusOK, prog)
}

func runYtDlpWithProgress(ctx context.Context, ytDlp string, args []string, rawURL string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, ytDlp, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = cmd.Stdout // combine stderr and stdout

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	var outputBuf bytes.Buffer
	scanner := bufio.NewScanner(stdout)

	setMediaProgress(rawURL, &mediaProgress{
		URL:    rawURL,
		Status: "starting",
	})

	percentRx := regexp.MustCompile(`\[download\]\s+([0-9.]+)%`)
	sizeRx := regexp.MustCompile(`of\s+(\S+)`)
	speedRx := regexp.MustCompile(`at\s+(\S+)`)
	etaRx := regexp.MustCompile(`ETA\s+(\S+)`)

	for scanner.Scan() {
		line := scanner.Text()
		outputBuf.WriteString(line + "\n")

		if strings.Contains(line, "[download]") {
			percentMatch := percentRx.FindStringSubmatch(line)
			if len(percentMatch) > 1 {
				pct, _ := strconv.ParseFloat(percentMatch[1], 64)
				
				prog := &mediaProgress{
					URL:     rawURL,
					Percent: pct,
					Status:  "downloading",
				}
				
				if sizeMatch := sizeRx.FindStringSubmatch(line); len(sizeMatch) > 1 {
					prog.Total = sizeMatch[1]
				}
				if speedMatch := speedRx.FindStringSubmatch(line); len(speedMatch) > 1 {
					prog.Speed = speedMatch[1]
				}
				if etaMatch := etaRx.FindStringSubmatch(line); len(etaMatch) > 1 {
					prog.ETA = etaMatch[1]
				}
				setMediaProgress(rawURL, prog)
			}
		} else if strings.Contains(line, "[Merger]") || strings.Contains(line, "Merging formats") {
			setMediaProgress(rawURL, &mediaProgress{
				URL:     rawURL,
				Percent: 100,
				Status:  "merging",
			})
		}
	}

	err = cmd.Wait()
	if err != nil {
		setMediaProgress(rawURL, &mediaProgress{
			URL:    rawURL,
			Status: "error",
		})
		return outputBuf.Bytes(), err
	}

	setMediaProgress(rawURL, &mediaProgress{
		URL:     rawURL,
		Percent: 100,
		Status:  "complete",
	})
	return outputBuf.Bytes(), nil
}
