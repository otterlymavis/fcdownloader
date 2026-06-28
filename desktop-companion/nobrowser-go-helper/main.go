package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/md5"
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
	maxURLLength         = 4096
	maxCookieBytes       = 32 * 1024
	defaultFormat        = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/best[ext=mp4]/best"
	youtubeFormat        = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/bestvideo[height<=1080]+bestaudio/best[height>=720][height<=1080]"
	bilibiliFormat       = "bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b/best"
	bilibiliCleanFormat  = "bv*[height>=720][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/bv*[height>=720][ext=mp4]+ba[ext=m4a]/bv*[height>=720]+ba/b[height>=720][ext=mp4]/b[height>=720]"
	pinnedYtDlpVersion   = "2026.03.17"
	defaultYtDlpBaseURL  = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17"
	nightlyYtDlpBaseURL  = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download"
	defaultFFmpegBaseURL = "https://raw.githubusercontent.com/imageio/imageio-binaries/master/ffmpeg"
	maxRequestsPerMinute = 90
)

var (
	serviceVersion        = "0.4.1-go"
	apiVersion            = "v1"
	buildID               = "dev"
	helperBuild           = "dev"
	minimumExtensionBuild = "1.5.25"
)

const helperVariant = "nobrowser-go"

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
		Addr:              net.JoinHostPort(host, helperPort()),
		Handler:           cors(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	logf("FCDownloader native helper listening on http://%s:%s", host, helperPort())
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
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-FCDL-Helper-Token, X-FCDL-Cookies")
		if strings.EqualFold(r.Header.Get("Access-Control-Request-Private-Network"), "true") {
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
		}
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
		"ok":          true,
		"service":     "fcdownloader-native-helper",
		"version":     serviceVersion,
		"helperBuild": strings.TrimSpace(helperBuild),
		"apiVersion":  apiVersion,
		"variant":     helperVariant,
		"buildId":     buildID,
		"compatibility": map[string]interface{}{
			"helperApi":             apiVersion,
			"minimumExtensionBuild": minimumExtensionBuild,
			"minimumWebBuild":       "1.5.0",
		},
		"ytDlpVersion":    toolPins.YtDlp.Version,
		"ytDlpAsset":      ytDlpAsset.Filename,
		"ytDlpChannel":    defaultYtDlpChannel(),
		"youtubeYtDlp":    "nightly",
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
	if err := ensureYtDlpTools(ctx); err != nil {
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

func ensureYtDlpTools(ctx context.Context) error {
	if _, err := ytDlpStablePath(ctx); err != nil {
		return err
	}
	if defaultYtDlpChannel() == "stable" || strings.TrimSpace(os.Getenv("FCDL_YTDLP_EXE")) != "" {
		return nil
	}
	if _, err := ytDlpNightlyPath(ctx); err != nil {
		if defaultYtDlpChannel() == "nightly" {
			return fmt.Errorf("stable yt-dlp is ready, but forced nightly prewarm failed: %w", err)
		}
		logf("YouTube nightly prewarm failed; stable yt-dlp remains available: %v", err)
	}
	return nil
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
	data, err := runYtDlpJSON(ctx, rawURL, r.Header.Get("X-FCDL-Cookies"))
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
	format := strings.TrimSpace(q.Get("format"))
	maxHeight := strings.TrimSpace(q.Get("max_height"))
	cookies := r.Header.Get("X-FCDL-Cookies")
	removeWatermark := truthy(q.Get("remove_watermark"))
	if bilibiliURL(rawURL) && removeWatermark {
		preflightCtx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		if err := ensureBilibiliTVNoWatermarkAvailable(preflightCtx, rawURL, maxHeight, cookies); err != nil {
			logf("Bilibili no-watermark preflight failed: %v", err)
			setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Status: "error"})
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
	}

	filePath, cleanup, err := downloadMedia(
		r.Context(),
		rawURL,
		format,
		maxHeight,
		cookies,
		removeWatermark,
	)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		logf("download error: %v", err)
		setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Status: "error"})
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}

	file, err := os.Open(filePath)
	if err != nil {
		logf("failed to open downloaded file: %v", err)
		setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Status: "error"})
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		logf("failed to stat downloaded file: %v", err)
		setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Status: "error"})
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}

	w.Header().Set("Content-Type", mediaContentType(filePath))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, safeName(filepath.Base(filePath))))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 99, Status: "serving"})
	if _, err := io.Copy(w, file); err != nil {
		logf("failed to serve downloaded file: %v", err)
		setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Status: "error"})
		return
	}
	setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 100, Status: "complete"})
}

func mediaContentType(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	case ".avi":
		return "video/x-msvideo"
	case ".mp3":
		return "audio/mpeg"
	case ".m4a", ".aac":
		return "audio/aac"
	case ".opus":
		return "audio/opus"
	case ".ogg":
		return "audio/ogg"
	case ".wav":
		return "audio/wav"
	case ".flac":
		return "audio/flac"
	default:
		return "application/octet-stream"
	}
}

func runYtDlpJSON(ctx context.Context, rawURL, cookies string) (map[string]interface{}, error) {
	if bilibiliURL(rawURL) {
		if data, err := runBilibiliAPIJSON(ctx, rawURL, cookies); err == nil {
			setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 10, Status: "extracted"})
			return data, nil
		} else {
			logf("Bilibili API formats failed; falling back to yt-dlp: %v", err)
		}
	}

	ytDlp, channel, err := ytDlpPrimaryPath(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	cookieFile, cookieCleanup, err := cookieFileFromHeader(cookies, rawURL)
	if err != nil {
		return nil, err
	}
	defer cookieCleanup()
	setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 5, Status: "extracting"})
	data, err := runYtDlpJSONWithPath(ctx, ytDlp, rawURL, cookieFile)
	if err == nil {
		setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 10, Status: "extracted"})
		return data, nil
	}
	if !youtubeURL(rawURL) {
		return data, err
	}
	if channel == "nightly" {
		logf("nightly yt-dlp failed for YouTube formats; retrying with stable: %v", err)
		setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: currentMediaPercent(rawURL), Status: "retrying"})
		stable, stableErr := ytDlpStablePath(ctx)
		if stableErr != nil {
			return nil, fmt.Errorf("%v; stable fallback unavailable: %w", err, stableErr)
		}
		data, err = runYtDlpJSONWithPath(ctx, stable, rawURL, cookieFile)
		if err == nil {
			setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 10, Status: "extracted"})
		}
		return data, err
	}
	if shouldRetryWithNightly(rawURL, err.Error()) {
		logf("stable yt-dlp failed for YouTube formats; retrying with nightly: %v", err)
		setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: currentMediaPercent(rawURL), Status: "retrying"})
		nightly, nightlyErr := ytDlpNightlyPath(ctx)
		if nightlyErr != nil {
			return nil, fmt.Errorf("%v; nightly fallback unavailable: %w", err, nightlyErr)
		}
		data, err = runYtDlpJSONWithPath(ctx, nightly, rawURL, cookieFile)
		if err == nil {
			setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 10, Status: "extracted"})
		}
		return data, err
	}
	return data, err
}

func runYtDlpJSONWithPath(ctx context.Context, ytDlp, rawURL, cookieFile string) (map[string]interface{}, error) {
	args := []string{
		"--ignore-config",
		"--dump-single-json",
		"--skip-download",
		"--no-warnings",
		"--socket-timeout", "30",
		"--js-runtimes", "node",
		"--remote-components", "ejs:github",
	}
	args = append(args, bilibiliHeaderArgs(rawURL)...)
	if cookieFile != "" {
		args = append(args, "--cookies", cookieFile)
	}
	args = append(args, rawURL)
	cmd := exec.CommandContext(ctx, ytDlp, args...)
	// Prevent orphaned node.js subprocesses from holding stdout/stderr pipes
	// open after context cancellation; abandon I/O after 5 s.
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.CombinedOutput()
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

func downloadMedia(ctx context.Context, rawURL, format, maxHeight, cookies string, removeWatermark bool) (string, func(), error) {
	ffmpeg, err := ffmpegPath(ctx)
	if err != nil {
		return "", nil, err
	}

	if bilibiliURL(rawURL) && removeWatermark {
		path, cleanup, err := downloadBilibiliTVNoWatermark(ctx, ffmpeg, rawURL, maxHeight, cookies)
		if err != nil {
			setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Status: "error"})
			return "", nil, err
		}
		return path, cleanup, nil
	}
	if bilibiliURL(rawURL) {
		if path, cleanup, err := downloadBilibiliAPI(ctx, ffmpeg, rawURL, format, maxHeight, cookies, false); err == nil {
			return path, cleanup, nil
		} else {
			logf("Bilibili API download failed; falling back to yt-dlp: %v", err)
		}
	}

	ytDlp, channel, err := ytDlpPrimaryPath(ctx, rawURL)
	if err != nil {
		return "", nil, err
	}
	if format == "" {
		if bilibiliURL(rawURL) {
			if removeWatermark {
				format = formatForHeight(bilibiliCleanFormat, maxHeight)
			} else {
				format = formatForHeight(bilibiliFormat, maxHeight)
			}
		} else if regexp.MustCompile(`^\d{3,4}$`).MatchString(maxHeight) {
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
	cookieFile, cookieCleanup, err := cookieFileFromHeader(cookies, rawURL)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	defer cookieCleanup()

	runCtx, cancel := context.WithTimeout(ctx, time.Hour)
	defer cancel()
	args := ytDlpDownloadArgs(format, ffmpeg, tmp, rawURL, cookieFile, removeWatermark)
	out, err := runYtDlpWithProgress(runCtx, ytDlp, args, rawURL)
	if err != nil {
		cleanup()
		stableErr := fmt.Errorf("%s", tail(out))
		if bilibiliURL(rawURL) {
			if apiPath, apiCleanup, apiErr := downloadBilibiliAPI(ctx, ffmpeg, rawURL, format, maxHeight, cookies, removeWatermark); apiErr == nil {
				return apiPath, apiCleanup, nil
			}
			if removeWatermark {
				return "", nil, errors.New("Bilibili only exposed its low-resolution watermarked preview. Sign in to Bilibili in Chrome and try again")
			}
		}
		if youtubeURL(rawURL) && channel == "nightly" {
			logf("nightly yt-dlp failed for YouTube download; retrying with stable: %v", stableErr)
			setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: currentMediaPercent(rawURL), Status: "retrying"})
			stable, stablePathErr := ytDlpStablePath(ctx)
			if stablePathErr != nil {
				return "", nil, fmt.Errorf("%v; stable fallback unavailable: %w", stableErr, stablePathErr)
			}
			return downloadMediaWithYtDlp(ctx, stable, ffmpeg, rawURL, format, cookies, removeWatermark)
		}
		if shouldRetryWithNightly(rawURL, stableErr.Error()) {
			logf("stable yt-dlp failed for YouTube download; retrying with nightly: %v", stableErr)
			setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: currentMediaPercent(rawURL), Status: "retrying"})
			nightly, nightlyErr := ytDlpNightlyPath(ctx)
			if nightlyErr != nil {
				return "", nil, fmt.Errorf("%v; nightly fallback unavailable: %w", stableErr, nightlyErr)
			}
			return downloadMediaWithYtDlp(ctx, nightly, ffmpeg, rawURL, format, cookies, removeWatermark)
		}
		return "", nil, stableErr
	}

	files, err := os.ReadDir(tmp)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	candidates := mediaFileCandidates(tmp, files)
	if len(candidates) == 0 {
		cleanup()
		return "", nil, errors.New("yt-dlp produced no media file")
	}
	return candidates[0], cleanup, nil
}

func downloadMediaWithYtDlp(ctx context.Context, ytDlp, ffmpeg, rawURL, format, cookies string, removeWatermark bool) (string, func(), error) {
	tmp, err := os.MkdirTemp("", "fcdl_native_*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	cookieFile, cookieCleanup, err := cookieFileFromHeader(cookies, rawURL)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	defer cookieCleanup()

	runCtx, cancel := context.WithTimeout(ctx, time.Hour)
	defer cancel()
	args := ytDlpDownloadArgs(format, ffmpeg, tmp, rawURL, cookieFile, removeWatermark)
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
	candidates := mediaFileCandidates(tmp, files)
	if len(candidates) == 0 {
		cleanup()
		return "", nil, errors.New("yt-dlp produced no media file")
	}
	return candidates[0], cleanup, nil
}

func finalizeDownloadedMedia(ctx context.Context, ffmpeg, rawURL, inputPath, tmp string, removeWatermark bool) (string, error) {
	if !removeWatermark || !bilibiliURL(rawURL) {
		return inputPath, nil
	}
	outputPath := filepath.Join(tmp, "fcdownloader-watermark-free.mp4")
	setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 96, Status: "removing-watermark"})
	if err := removeBilibiliWatermark(ctx, ffmpeg, inputPath, outputPath); err != nil {
		return "", err
	}
	setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 98, Status: "ready"})
	return outputPath, nil
}

func removeBilibiliWatermark(ctx context.Context, ffmpeg, inputPath, outputPath string) error {
	videoArgs := []string{"-c:v", "libx264", "-preset", "veryfast", "-crf", "18"}
	if runtime.GOOS == "darwin" {
		videoArgs = []string{"-c:v", "h264_videotoolbox", "-b:v", "5000k", "-maxrate", "8000k", "-bufsize", "16000k"}
	}
	args := []string{
		"-y", "-i", inputPath,
		"-vf", "delogo=x=24:y=34:w=410:h=82:show=0",
	}
	args = append(args, videoArgs...)
	args = append(args, "-c:a", "copy", "-movflags", "+faststart", outputPath)
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg Bilibili watermark cleanup failed: %s", tail(out))
	}
	return nil
}

func mediaFileCandidates(dir string, files []os.DirEntry) []string {
	var candidates []string
	for _, file := range files {
		if !file.Type().IsRegular() {
			continue
		}
		path := filepath.Join(dir, file.Name())
		if !isMediaOutputFile(path) || validateMediaOutputFile(path) != nil {
			continue
		}
		candidates = append(candidates, path)
	}
	sort.Slice(candidates, func(i, j int) bool {
		ai, _ := os.Stat(candidates[i])
		aj, _ := os.Stat(candidates[j])
		return ai.Size() > aj.Size()
	})
	return candidates
}

func validateMediaOutputFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		return errors.New("downloader produced an empty media file")
	}
	prefix := make([]byte, 512)
	n, err := file.Read(prefix)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	sample := strings.ToLower(strings.TrimSpace(string(prefix[:n])))
	for _, marker := range []string{"{", "[", "<html", "<!doctype html", "<?xml"} {
		if strings.HasPrefix(sample, marker) {
			return errors.New("downloader returned a JSON/page response instead of media")
		}
	}
	return nil
}

func isMediaOutputFile(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mp3", ".m4a", ".aac", ".opus", ".ogg", ".wav", ".flac":
		return true
	default:
		return false
	}
}

func ytDlpDownloadArgs(format, ffmpeg, tmp, rawURL, cookieFile string, removeWatermark bool) []string {
	concurrentFragments := strings.TrimSpace(os.Getenv("FCDL_YTDLP_CONCURRENT_FRAGMENTS"))
	if concurrentFragments == "" {
		concurrentFragments = "4"
	}
	args := []string{
		"--ignore-config",
		"-f", format,
		"--newline",
		"--continue",
		"--retries", "infinite",
		"--fragment-retries", "infinite",
		"--file-access-retries", "5",
		"--retry-sleep", "3",
		"--socket-timeout", "30",
		"--http-chunk-size", "10M",
		"--concurrent-fragments", concurrentFragments,
		"--merge-output-format", "mp4",
		"--remux-video", "mp4",
		"--js-runtimes", "node",
		"--remote-components", "ejs:github",
		"--ffmpeg-location", ffmpeg,
		"-o", filepath.Join(tmp, "%(title).120s-%(id)s.%(ext)s"),
	}
	if youtubeURL(rawURL) {
		args = append(args, "--extractor-args", "youtube:player_client=default")
	}
	args = append(args, bilibiliHeaderArgs(rawURL)...)
	if cookieFile != "" {
		args = append(args, "--cookies", cookieFile)
	}
	args = append(args, rawURL)
	return args
}

func ytDlpPrimaryPath(ctx context.Context, rawURL string) (string, string, error) {
	channel := defaultYtDlpChannel()
	if channel == "nightly" {
		path, err := ytDlpNightlyPath(ctx)
		return path, "nightly", err
	}
	if channel == "stable" {
		path, err := ytDlpStablePath(ctx)
		return path, "stable", err
	}
	if strings.TrimSpace(os.Getenv("FCDL_YTDLP_EXE")) != "" {
		path, err := ytDlpStablePath(ctx)
		return path, "stable", err
	}
	if youtubeURL(rawURL) {
		path, err := ytDlpNightlyPath(ctx)
		if err == nil {
			return path, "nightly", nil
		}
		logf("nightly yt-dlp unavailable for YouTube; using stable: %v", err)
	}
	path, err := ytDlpStablePath(ctx)
	return path, "stable", err
}

func ytDlpPath(ctx context.Context) (string, error) {
	if defaultYtDlpChannel() == "nightly" {
		return ytDlpNightlyPath(ctx)
	}
	return ytDlpStablePath(ctx)
}

func defaultYtDlpChannel() string {
	channel := strings.ToLower(strings.TrimSpace(os.Getenv("FCDL_YTDLP_CHANNEL")))
	if channel == "nightly" || channel == "stable" {
		return channel
	}
	return "auto"
}

func ytDlpStablePath(ctx context.Context) (string, error) {
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
	target := stableYtDlpCachePath()
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

func ytDlpNightlyPath(ctx context.Context) (string, error) {
	asset, err := platformNightlyYtDlpAsset(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	target := nightlyYtDlpCachePath()
	if cachedNightlyToolValid(target) {
		return target, nil
	}
	if err := downloadFile(ctx, "yt-dlp-nightly", asset.URL, target, ""); err != nil {
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
		return ffmpegAlias(target)
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
	return ffmpegAlias(target)
}

func ffmpegAlias(target string) (string, error) {
	name := "ffmpeg"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	alias := filepath.Join(filepath.Dir(target), name)
	if filepath.Clean(alias) == filepath.Clean(target) {
		return target, nil
	}
	if executable(alias) {
		return alias, nil
	}
	_ = os.Remove(alias)
	if err := os.Link(target, alias); err != nil {
		if err := os.Symlink(target, alias); err != nil {
			return "", fmt.Errorf("create ffmpeg alias: %w", err)
		}
	}
	return alias, nil
}

func stableYtDlpCachePath() string {
	return filepath.Join(cacheRoot(), "bin", toolExecutableName("yt-dlp", runtime.GOOS))
}

func nightlyYtDlpCachePath() string {
	return filepath.Join(cacheRoot(), "bin", "nightly-"+toolExecutableName("yt-dlp", runtime.GOOS))
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

func platformNightlyYtDlpAsset(goos, goarch string) (toolAsset, error) {
	filename := "yt-dlp"
	if goos == "windows" {
		filename = "yt-dlp.exe"
	} else if goos == "darwin" {
		filename = "yt-dlp_macos"
	}
	return toolAsset{
		URL:      strings.TrimRight(nightlyYtDlpBaseURL, "/") + "/" + filename,
		Filename: filename,
	}, nil
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

func cachedNightlyToolValid(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if time.Since(info.ModTime()) > 24*time.Hour {
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
	nightlyYtDlpAsset, _ := platformNightlyYtDlpAsset(runtime.GOOS, runtime.GOARCH)
	ffmpegAsset, _ := platformFFmpegAsset(runtime.GOOS, runtime.GOARCH)
	return map[string]bool{
		"yt-dlp":         ytDlpAsset.Filename != "" && executable(stableYtDlpCachePath()),
		"yt-dlp-nightly": nightlyYtDlpAsset.Filename != "" && executable(nightlyYtDlpCachePath()),
		"ffmpeg":         ffmpegAsset.Filename != "" && executable(filepath.Join(cacheRoot(), "ffmpeg", ffmpegAsset.Filename)),
	}
}

func toolStatuses() []toolStatus {
	ytDlpAsset, _ := platformYtDlpAsset(runtime.GOOS, runtime.GOARCH)
	nightlyYtDlpAsset, _ := platformNightlyYtDlpAsset(runtime.GOOS, runtime.GOARCH)
	ffmpegAsset, _ := platformFFmpegAsset(runtime.GOOS, runtime.GOARCH)
	return []toolStatus{
		statusForTool("yt-dlp", stableYtDlpCachePath(), ytDlpAsset),
		statusForTool("yt-dlp-nightly", nightlyYtDlpCachePath(), nightlyYtDlpAsset),
		statusForTool("ffmpeg", filepath.Join(cacheRoot(), "ffmpeg", ffmpegAsset.Filename), ffmpegAsset),
	}
}

func toolsNeedSetup() bool {
	return toolsNeedSetupFromStatuses(toolStatuses())
}

func toolsNeedSetupFromStatuses(tools []toolStatus) bool {
	for _, tool := range tools {
		if tool.Name == "yt-dlp-nightly" && defaultYtDlpChannel() != "nightly" {
			continue
		}
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

func helperPort() string {
	value := strings.TrimSpace(os.Getenv("FCDL_HELPER_PORT"))
	if value == "" {
		return port
	}
	if _, err := strconv.Atoi(value); err != nil {
		return port
	}
	return value
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
		lower := strings.ToLower(strings.TrimSpace(origin))
		if strings.HasPrefix(lower, "chrome-extension://") ||
			strings.HasPrefix(lower, "moz-extension://") ||
			strings.HasPrefix(lower, "http://localhost") ||
			strings.HasPrefix(lower, "http://127.0.0.1") ||
			strings.HasPrefix(lower, "http://[::1]") {
			return origin
		}
		return "null"
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

func bilibiliURL(value string) bool {
	parsed, _ := url.Parse(value)
	host := strings.ToLower(parsed.Hostname())
	return strings.HasSuffix(host, "bilibili.com") || host == "b23.tv" || strings.HasSuffix(host, "bilibili.tv")
}

func bilibiliHeaderArgs(rawURL string) []string {
	if !bilibiliURL(rawURL) {
		return nil
	}
	return []string{
		"--referer", "https://www.bilibili.com/",
		"--add-header", "Origin:https://www.bilibili.com",
		"--add-header", "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
	}
}

func formatForHeight(format, maxHeight string) string {
	if !regexp.MustCompile(`^\d{3,4}$`).MatchString(maxHeight) {
		return format
	}
	return strings.ReplaceAll(format, "height<=1080", "height<="+maxHeight)
}

func truthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func cookieFileFromHeader(cookies, pageURL string) (string, func(), error) {
	cookies = strings.TrimSpace(cookies)
	if cookies == "" {
		return "", func() {}, nil
	}
	if len([]byte(cookies)) > maxCookieBytes {
		return "", func() {}, fmt.Errorf("cookie payload exceeds %d KB limit", maxCookieBytes/1024)
	}
	if !strings.Contains(cookies, "=") {
		return "", func() {}, errors.New("no valid name=value cookie pairs found")
	}
	domains := cookieDomainsForURL(pageURL)
	if len(domains) == 0 {
		return "", func() {}, nil
	}
	file, err := os.CreateTemp("", "fcdl_native_cookies_*.txt")
	if err != nil {
		return "", func() {}, err
	}
	path := file.Name()
	cleanup := func() { _ = os.Remove(path) }
	if runtime.GOOS != "windows" {
		_ = os.Chmod(path, 0o600)
	}
	expiry := time.Now().Add(24 * time.Hour).Unix()
	writer := bufio.NewWriter(file)
	_, _ = writer.WriteString("# Netscape HTTP Cookie File\n")
	_, _ = writer.WriteString("# Generated by FCDownloader native helper per request\n")
	for _, raw := range strings.Split(cookies, ";") {
		raw = strings.TrimSpace(raw)
		if raw == "" || !strings.Contains(raw, "=") {
			continue
		}
		parts := strings.SplitN(raw, "=", 2)
		name := cookieField(strings.TrimSpace(parts[0]))
		value := cookieField(strings.TrimSpace(parts[1]))
		if name == "" {
			continue
		}
		for _, domain := range domains {
			_, _ = fmt.Fprintf(writer, "%s\tTRUE\t/\tFALSE\t%d\t%s\t%s\n", domain, expiry, name, value)
		}
	}
	if err := writer.Flush(); err != nil {
		_ = file.Close()
		cleanup()
		return "", func() {}, err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return path, cleanup, nil
}

func cookieDomainsForURL(pageURL string) []string {
	parsed, _ := url.Parse(pageURL)
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return nil
	}
	if strings.HasSuffix(host, "bilibili.com") || strings.HasSuffix(host, "bilibili.tv") || host == "b23.tv" {
		return []string{".bilibili.com", ".bilivideo.com", ".b23.tv", ".bilibili.tv"}
	}
	parts := strings.Split(host, ".")
	if len(parts) > 2 && len(parts[len(parts)-1]) >= 2 {
		return []string{"." + strings.Join(parts[len(parts)-2:], ".")}
	}
	return []string{"." + host}
}

func cookieField(value string) string {
	value = strings.ReplaceAll(value, "\t", "")
	value = strings.ReplaceAll(value, "\r", "")
	value = strings.ReplaceAll(value, "\n", "")
	return value
}

type biliAPIResult struct {
	BVID      string
	CID       int64
	Title     string
	Thumbnail string
	Duration  interface{}
	Play      map[string]interface{}
}

func runBilibiliAPIJSON(ctx context.Context, rawURL, cookies string) (map[string]interface{}, error) {
	result, err := fetchBilibiliAPI(ctx, rawURL, cookies)
	if err != nil {
		return nil, err
	}
	formats := bilibiliFormatsFromPlay(result.Play)
	return map[string]interface{}{
		"ok":         true,
		"service":    "fcdownloader-native-helper",
		"extractor":  "BiliBiliAPI",
		"title":      result.Title,
		"thumbnail":  result.Thumbnail,
		"id":         result.BVID,
		"webpageUrl": rawURL,
		"duration":   result.Duration,
		"formats":    formats,
	}, nil
}

func downloadBilibiliAPI(ctx context.Context, ffmpeg, rawURL, format, maxHeight, cookies string, requireCleanHD bool) (string, func(), error) {
	result, err := fetchBilibiliAPI(ctx, rawURL, cookies)
	if err != nil {
		return "", nil, err
	}
	tmp, err := os.MkdirTemp("", "fcdl_native_bili_*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }

	audio := bestBilibiliAudio(result.Play)
	if audioURL := firstString(audio["baseUrl"], audio["base_url"]); audioURL != "" {
		var lastErr error
		candidates := bilibiliDashVideoCandidates(result.Play, format, maxHeight, requireCleanHD)
		if len(candidates) == 0 && strings.TrimSpace(format) != "" {
			cleanup()
			return "", nil, fmt.Errorf("Bilibili did not expose selected format %s", format)
		}
		for index, video := range candidates {
			videoURL := firstString(video["baseUrl"], video["base_url"])
			if videoURL == "" {
				continue
			}
			outPath := filepath.Join(tmp, safeName(firstString(result.Title, result.BVID))+".mp4")
			if index > 0 {
				_ = os.Remove(outPath)
				setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 20, Status: "retrying"})
			}
			if err := muxBilibiliDash(ctx, ffmpeg, videoURL, audioURL, outPath, cookies); err != nil {
				lastErr = err
				logf("Bilibili DASH candidate failed height=%v quality=%v: %v", video["height"], firstNonNil(video["id"], video["quality"], video["qn"]), err)
				continue
			}
			if requireCleanHD {
				cleanPath := filepath.Join(tmp, "fcdownloader-watermark-free.mp4")
				setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 96, Status: "removing-watermark"})
				if err := removeBilibiliWatermark(ctx, ffmpeg, outPath, cleanPath); err != nil {
					cleanup()
					return "", nil, err
				}
				return cleanPath, cleanup, nil
			}
			return outPath, cleanup, nil
		}
		if requireCleanHD && lastErr != nil {
			cleanup()
			return "", nil, lastErr
		}
	}

	if !requireCleanHD {
		if mediaURL := pickBilibiliDurl(result.Play); mediaURL != "" {
			outPath := filepath.Join(tmp, safeName(firstString(result.Title, result.BVID))+".mp4")
			if err := downloadBilibiliFile(ctx, mediaURL, outPath, cookies); err != nil {
				cleanup()
				return "", nil, err
			}
			return outPath, cleanup, nil
		}
	}

	cleanup()
	return "", nil, errors.New("Bilibili API returned no downloadable media")
}

func downloadBilibiliTVNoWatermark(ctx context.Context, ffmpeg, rawURL, maxHeight, cookies string) (string, func(), error) {
	result, err := fetchBilibiliTVAPI(ctx, rawURL, cookies)
	if err != nil {
		return "", nil, err
	}
	videoURL, audioURL := pickBilibiliTVCleanDash(result.Play, maxHeight)
	if videoURL == "" || audioURL == "" {
		return "", nil, errors.New("Bilibili did not expose a true no-watermark source for this video; refusing to blur the watermark")
	}
	tmp, err := os.MkdirTemp("", "fcdl_native_bili_tv_*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	outPath := filepath.Join(tmp, safeName(firstString(result.Title, result.BVID))+".mp4")
	if err := muxBilibiliDash(ctx, ffmpeg, videoURL, audioURL, outPath, cookies); err != nil {
		cleanup()
		return "", nil, err
	}
	return outPath, cleanup, nil
}

func ensureBilibiliTVNoWatermarkAvailable(ctx context.Context, rawURL, maxHeight, cookies string) error {
	result, err := fetchBilibiliTVAPI(ctx, rawURL, cookies)
	if err != nil {
		return err
	}
	videoURL, audioURL := pickBilibiliTVCleanDash(result.Play, maxHeight)
	if videoURL == "" || audioURL == "" {
		return errors.New("Bilibili did not expose a true no-watermark source for this video; refusing to blur the watermark")
	}
	return nil
}

func fetchBilibiliTVAPI(ctx context.Context, rawURL, cookies string) (biliAPIResult, error) {
	result, err := fetchBilibiliAPI(ctx, rawURL, cookies)
	if err != nil {
		return biliAPIResult{}, err
	}
	aid := int64(numberValue(result.Play["aid"]))
	if aid == 0 {
		// The web playurl payload does not include aid; fetchBilibiliAPI already
		// resolved metadata, so ask the view endpoint again to keep this helper
		// small and deterministic.
		bvid := firstString(result.BVID)
		viewURL := "https://api.bilibili.com/x/web-interface/view?" + url.Values{"bvid": {bvid}}.Encode()
		var viewResp map[string]interface{}
		if err := fetchBilibiliJSON(ctx, viewURL, rawURL, cookies, &viewResp); err != nil {
			return biliAPIResult{}, err
		}
		if data, _ := viewResp["data"].(map[string]interface{}); data != nil {
			aid = int64(numberValue(data["aid"]))
		}
	}
	if aid == 0 || result.CID == 0 {
		return biliAPIResult{}, errors.New("Bilibili TV API requires aid and cid")
	}
	values := url.Values{
		"appkey":   {"4409e2ce8ffd12b8"},
		"avid":     {strconv.FormatInt(aid, 10)},
		"build":    {"103800"},
		"cid":      {strconv.FormatInt(result.CID, 10)},
		"device":   {"android"},
		"fnval":    {"80"},
		"fnver":    {"0"},
		"fourk":    {"1"},
		"mobi_app": {"android_tv_yst"},
		"platform": {"android"},
		"qn":       {"120"},
		"ts":       {strconv.FormatInt(time.Now().Unix(), 10)},
	}
	values.Set("sign", bilibiliTVSign(values))
	playURL := "https://api.snm0516.aisee.tv/x/tv/ugc/playurl?" + values.Encode()
	var playResp map[string]interface{}
	if err := fetchBilibiliTVJSON(ctx, playURL, rawURL, &playResp); err != nil {
		return biliAPIResult{}, err
	}
	if code, _ := playResp["code"].(float64); code != 0 {
		return biliAPIResult{}, fmt.Errorf("Bilibili TV playurl API failed: %s", firstString(playResp["message"], playResp["msg"]))
	}
	return biliAPIResult{
		BVID:      result.BVID,
		CID:       result.CID,
		Title:     result.Title,
		Thumbnail: result.Thumbnail,
		Duration:  result.Duration,
		Play:      playResp,
	}, nil
}

func fetchBilibiliTVJSON(ctx context.Context, requestURL, pageURL string, target interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 BiliDroid/1.6.6 os/android mobi_app/android_tv_yst build/103800 channel/master innerVer/103800 osVer/11 network/2")
	req.Header.Set("Referer", firstString(pageURL, "https://www.bilibili.com/"))
	req.Header.Set("Accept", "*/*")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Bilibili TV API HTTP %d", resp.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024))
	return decoder.Decode(target)
}

func bilibiliTVSign(values url.Values) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		if strings.EqualFold(key, "sign") {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var data strings.Builder
	for _, key := range keys {
		if data.Len() > 0 {
			data.WriteByte('&')
		}
		data.WriteString(key)
		data.WriteByte('=')
		data.WriteString(url.QueryEscape(values.Get(key)))
	}
	data.WriteString("59b43e04ad6965f34319062b478f83dd")
	sum := md5.Sum([]byte(data.String()))
	return hex.EncodeToString(sum[:])
}

func fetchBilibiliAPI(ctx context.Context, rawURL, cookies string) (biliAPIResult, error) {
	bvid := resolveBVID(ctx, rawURL, cookies)
	if bvid == "" {
		return biliAPIResult{}, errors.New("Bilibili URL did not contain a BV id")
	}
	viewURL := "https://api.bilibili.com/x/web-interface/view?" + url.Values{"bvid": {bvid}}.Encode()
	var viewResp map[string]interface{}
	if err := fetchBilibiliJSON(ctx, viewURL, rawURL, cookies, &viewResp); err != nil {
		return biliAPIResult{}, err
	}
	if code, _ := viewResp["code"].(float64); code != 0 {
		return biliAPIResult{}, fmt.Errorf("Bilibili view API failed: %s", firstString(viewResp["message"], viewResp["msg"]))
	}
	data, _ := viewResp["data"].(map[string]interface{})
	if data == nil {
		return biliAPIResult{}, errors.New("Bilibili view API returned no data")
	}
	cid := int64(numberValue(data["cid"]))
	aid := int64(numberValue(data["aid"]))
	if cid == 0 {
		return biliAPIResult{}, errors.New("Bilibili view API returned no cid")
	}

	playValues := url.Values{
		"bvid":     {bvid},
		"cid":      {strconv.FormatInt(cid, 10)},
		"qn":       {"120"},
		"fnval":    {"4048"},
		"fourk":    {"1"},
		"try_look": {"1"},
	}
	if aid > 0 {
		playValues.Set("avid", strconv.FormatInt(aid, 10))
	}
	playURL := "https://api.bilibili.com/x/player/playurl?" + playValues.Encode()
	var playResp map[string]interface{}
	if err := fetchBilibiliJSON(ctx, playURL, rawURL, cookies, &playResp); err != nil {
		return biliAPIResult{}, err
	}
	if code, _ := playResp["code"].(float64); code != 0 {
		return biliAPIResult{}, fmt.Errorf("Bilibili playurl API failed: %s", firstString(playResp["message"], playResp["msg"]))
	}
	playData, _ := playResp["data"].(map[string]interface{})
	if playData == nil {
		return biliAPIResult{}, errors.New("Bilibili playurl API returned no data")
	}

	return biliAPIResult{
		BVID:      bvid,
		CID:       cid,
		Title:     firstString(data["title"], bvid),
		Thumbnail: firstString(data["pic"]),
		Duration:  data["duration"],
		Play:      playData,
	}, nil
}

func fetchBilibiliJSON(ctx context.Context, requestURL, pageURL, cookies string, target interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return err
	}
	applyBilibiliHTTPHeaders(req.Header, pageURL, cookies)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Bilibili API HTTP %d", resp.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024))
	return decoder.Decode(target)
}

func applyBilibiliHTTPHeaders(headers http.Header, pageURL, cookies string) {
	headers.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
	headers.Set("Referer", firstString(pageURL, "https://www.bilibili.com/"))
	headers.Set("Origin", "https://www.bilibili.com")
	if strings.TrimSpace(cookies) != "" {
		headers.Set("Cookie", cookies)
	}
}

func extractBVID(rawURL string) string {
	match := regexp.MustCompile(`(?i)\bBV[0-9A-Za-z]+`).FindString(rawURL)
	return match
}

func resolveBVID(ctx context.Context, rawURL, cookies string) string {
	if bvid := extractBVID(rawURL); bvid != "" {
		return bvid
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return ""
	}
	applyBilibiliHTTPHeaders(req.Header, "https://www.bilibili.com/", cookies)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if bvid := extractBVID(resp.Request.URL.String()); bvid != "" {
		return bvid
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	return extractBVID(string(body))
}

func bilibiliFormatsFromPlay(play map[string]interface{}) []formatInfo {
	var formats []formatInfo
	if dash, _ := play["dash"].(map[string]interface{}); dash != nil {
		for _, item := range interfaceSlice(dash["video"]) {
			video, _ := item.(map[string]interface{})
			if video == nil || firstString(video["baseUrl"], video["base_url"]) == "" {
				continue
			}
			id := firstString(video["id"], video["codecid"])
			height := video["height"]
			label := firstString(video["new_description"], video["format_note"])
			if label == "" && height != nil {
				label = fmt.Sprintf("%.0fp", numberValue(height))
			}
			formats = append(formats, formatInfo{
				FormatID: "bili-dash-v-" + id,
				Label:    label,
				Height:   height,
				Ext:      "mp4",
				VCodec:   video["codecs"],
				ACodec:   "none",
				Filesize: firstNonNil(video["size"], video["bandwidth"]),
				Protocol: "https",
			})
		}
		for _, item := range interfaceSlice(dash["audio"]) {
			audio, _ := item.(map[string]interface{})
			if audio == nil || firstString(audio["baseUrl"], audio["base_url"]) == "" {
				continue
			}
			id := firstString(audio["id"])
			formats = append(formats, formatInfo{
				FormatID: "bili-dash-a-" + id,
				Label:    "audio",
				Ext:      "m4a",
				VCodec:   "none",
				ACodec:   audio["codecs"],
				Filesize: firstNonNil(audio["size"], audio["bandwidth"]),
				Protocol: "https",
			})
		}
	}
	for _, item := range interfaceSlice(play["durl"]) {
		durl, _ := item.(map[string]interface{})
		mediaURL := firstString(durl["url"])
		if mediaURL == "" {
			continue
		}
		quality := firstNonNil(play["quality"], durl["quality"])
		formats = append(formats, formatInfo{
			FormatID: "bili-durl-" + firstString(quality, durl["order"]),
			Label:    firstString(play["format"], "mp4"),
			Height:   quality,
			Ext:      "mp4",
			Filesize: durl["size"],
			Protocol: "https",
		})
	}
	sort.SliceStable(formats, func(i, j int) bool {
		return betterBilibiliFormat(formats[i], formats[j])
	})
	return formats
}

func betterBilibiliFormat(candidate, current formatInfo) bool {
	candidateAudio := strings.EqualFold(firstString(candidate.VCodec), "none")
	currentAudio := strings.EqualFold(firstString(current.VCodec), "none")
	if candidateAudio != currentAudio {
		return !candidateAudio
	}
	candidateHeight := numberValue(candidate.Height)
	currentHeight := numberValue(current.Height)
	if candidateHeight != currentHeight {
		return candidateHeight > currentHeight
	}
	candidateQuality := numberValue(regexp.MustCompile(`\d+`).FindString(candidate.FormatID))
	currentQuality := numberValue(regexp.MustCompile(`\d+`).FindString(current.FormatID))
	if candidateQuality != currentQuality {
		return candidateQuality > currentQuality
	}
	candidateSize := numberValue(candidate.Filesize)
	currentSize := numberValue(current.Filesize)
	if candidateSize != currentSize {
		return candidateSize > currentSize
	}
	return false
}

func pickBilibiliDash(play map[string]interface{}, maxHeight string, requireCleanHD bool) (string, string) {
	candidates := bilibiliDashVideoCandidates(play, "", maxHeight, requireCleanHD)
	audio := bestBilibiliAudio(play)
	if len(candidates) == 0 || audio == nil {
		return "", ""
	}
	return firstString(candidates[0]["baseUrl"], candidates[0]["base_url"]), firstString(audio["baseUrl"], audio["base_url"])
}

func bilibiliDashVideoCandidates(play map[string]interface{}, format, maxHeight string, requireCleanHD bool) []map[string]interface{} {
	dash, _ := play["dash"].(map[string]interface{})
	if dash == nil {
		return nil
	}
	selectedQuality := bilibiliSelectedQuality(format)
	heightLimit := 100000.0
	if regexp.MustCompile(`^\d{3,4}$`).MatchString(maxHeight) {
		if parsed, err := strconv.Atoi(maxHeight); err == nil {
			heightLimit = float64(parsed)
		}
	}
	var candidates []map[string]interface{}
	for _, item := range interfaceSlice(dash["video"]) {
		video, _ := item.(map[string]interface{})
		if video == nil {
			continue
		}
		mediaURL := firstString(video["baseUrl"], video["base_url"])
		height := numberValue(video["height"])
		qualityID := int(numberValue(firstNonNil(video["id"], video["quality"], video["qn"])))
		if mediaURL == "" || height <= 0 || height > heightLimit || (requireCleanHD && height < 720) || (selectedQuality > 0 && qualityID != selectedQuality) {
			continue
		}
		candidates = append(candidates, video)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return betterBilibiliVideo(candidates[i], candidates[j])
	})
	return candidates
}

func bilibiliSelectedQuality(format string) int {
	format = strings.TrimSpace(format)
	if format == "" {
		return 0
	}
	match := regexp.MustCompile(`(?i)^bili-dash-v-(\d+)$`).FindStringSubmatch(format)
	if len(match) == 2 {
		if value, err := strconv.Atoi(match[1]); err == nil {
			return value
		}
	}
	return 0
}

func bestBilibiliAudio(play map[string]interface{}) map[string]interface{} {
	dash, _ := play["dash"].(map[string]interface{})
	if dash == nil {
		return nil
	}
	var bestAudio map[string]interface{}
	for _, item := range interfaceSlice(dash["audio"]) {
		audio, _ := item.(map[string]interface{})
		if audio == nil || firstString(audio["baseUrl"], audio["base_url"]) == "" {
			continue
		}
		if bestAudio == nil || numberValue(audio["bandwidth"]) > numberValue(bestAudio["bandwidth"]) {
			bestAudio = audio
		}
	}
	return bestAudio
}

func pickBilibiliTVCleanDash(play map[string]interface{}, maxHeight string) (string, string) {
	cleanQualityIDs := map[int]bool{}
	qualities := interfaceSlice(play["accept_quality"])
	watermarks := interfaceSlice(play["accept_watermark"])
	for i, quality := range qualities {
		if i >= len(watermarks) {
			continue
		}
		watermarked, ok := watermarks[i].(bool)
		if ok && !watermarked {
			cleanQualityIDs[int(numberValue(quality))] = true
		}
	}
	if len(cleanQualityIDs) == 0 {
		return "", ""
	}
	dash, _ := play["dash"].(map[string]interface{})
	if dash == nil {
		return "", ""
	}
	heightLimit := 100000.0
	if regexp.MustCompile(`^\d{3,4}$`).MatchString(maxHeight) {
		if parsed, err := strconv.Atoi(maxHeight); err == nil {
			heightLimit = float64(parsed)
		}
	}
	var bestVideo map[string]interface{}
	for _, item := range interfaceSlice(dash["video"]) {
		video, _ := item.(map[string]interface{})
		if video == nil {
			continue
		}
		qualityID := int(numberValue(video["id"]))
		mediaURL := firstString(video["baseUrl"], video["base_url"])
		height := numberValue(video["height"])
		if mediaURL == "" || !cleanQualityIDs[qualityID] || height < 720 || height > heightLimit {
			continue
		}
		if betterBilibiliVideo(video, bestVideo) {
			bestVideo = video
		}
	}
	var bestAudio map[string]interface{}
	for _, item := range interfaceSlice(dash["audio"]) {
		audio, _ := item.(map[string]interface{})
		if audio == nil || firstString(audio["baseUrl"], audio["base_url"]) == "" {
			continue
		}
		if bestAudio == nil || numberValue(audio["bandwidth"]) > numberValue(bestAudio["bandwidth"]) {
			bestAudio = audio
		}
	}
	if bestVideo == nil || bestAudio == nil {
		return "", ""
	}
	return firstString(bestVideo["baseUrl"], bestVideo["base_url"]), firstString(bestAudio["baseUrl"], bestAudio["base_url"])
}

func betterBilibiliVideo(candidate, current map[string]interface{}) bool {
	if candidate == nil {
		return false
	}
	if current == nil {
		return true
	}
	candidateHeight := numberValue(candidate["height"])
	currentHeight := numberValue(current["height"])
	if candidateHeight != currentHeight {
		return candidateHeight > currentHeight
	}
	candidateQuality := numberValue(firstNonNil(candidate["id"], candidate["quality"], candidate["qn"]))
	currentQuality := numberValue(firstNonNil(current["id"], current["quality"], current["qn"]))
	if candidateQuality != currentQuality {
		return candidateQuality > currentQuality
	}
	candidateSize := numberValue(firstNonNil(candidate["size"], candidate["filesize"], candidate["bandwidth"]))
	currentSize := numberValue(firstNonNil(current["size"], current["filesize"], current["bandwidth"]))
	if candidateSize != currentSize {
		return candidateSize > currentSize
	}
	candidateIsAVC := strings.Contains(firstString(candidate["codecs"], candidate["vcodec"]), "avc1")
	currentIsAVC := strings.Contains(firstString(current["codecs"], current["vcodec"]), "avc1")
	return candidateIsAVC && !currentIsAVC
}

func pickBilibiliDurl(play map[string]interface{}) string {
	var best map[string]interface{}
	for _, item := range interfaceSlice(play["durl"]) {
		durl, _ := item.(map[string]interface{})
		if durl == nil || firstString(durl["url"]) == "" {
			continue
		}
		if best == nil || numberValue(durl["size"]) > numberValue(best["size"]) {
			best = durl
		}
	}
	if best == nil {
		return ""
	}
	return firstString(best["url"])
}

func muxBilibiliDash(ctx context.Context, ffmpeg, videoURL, audioURL, outPath, cookies string) error {
	headers := bilibiliFFmpegHeaders(cookies)
	cmd := exec.CommandContext(ctx, ffmpeg,
		"-y",
		"-rw_timeout", "15000000",
		"-headers", headers,
		"-i", videoURL,
		"-rw_timeout", "15000000",
		"-headers", headers,
		"-i", audioURL,
		"-c", "copy",
		"-movflags", "+faststart",
		outPath,
	)
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg Bilibili mux failed: %s", tail(out))
	}
	return nil
}

func downloadBilibiliFile(ctx context.Context, mediaURL, outPath, cookies string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, mediaURL, nil)
	if err != nil {
		return err
	}
	applyBilibiliHTTPHeaders(req.Header, "https://www.bilibili.com/", cookies)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Bilibili media HTTP %d", resp.StatusCode)
	}
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(contentType, "json") || strings.Contains(contentType, "html") || strings.Contains(contentType, "xml") {
		return fmt.Errorf("Bilibili returned %s instead of media", contentType)
	}
	out, err := os.Create(outPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return validateMediaOutputFile(outPath)
}

func bilibiliFFmpegHeaders(cookies string) string {
	headers := "Referer: https://www.bilibili.com/\r\nOrigin: https://www.bilibili.com\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36\r\n"
	if strings.TrimSpace(cookies) != "" {
		headers += "Cookie: " + cookieField(cookies) + "\r\n"
	}
	return headers
}

func interfaceSlice(value interface{}) []interface{} {
	items, _ := value.([]interface{})
	return items
}

func numberValue(value interface{}) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(v, 64)
		return f
	default:
		return 0
	}
}

func shouldRetryWithNightly(rawURL, message string) bool {
	if !youtubeURL(rawURL) {
		return false
	}
	text := strings.ToLower(message)
	for _, needle := range []string{
		"403",
		"bot",
		"sabr",
		"nsig",
		"signature",
		"requested format is not available",
		"unable to extract",
		"sign in to confirm",
		"this video is unavailable",
	} {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
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
	Status     string  `json:"status"`
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
	if current := mediaDownloads[url]; current != nil && p.Status == "downloading" {
		if p.Percent < current.Percent {
			p.Percent = current.Percent
		}
		if p.Percent > 95 {
			p.Percent = 95
		}
		if p.Speed == "" {
			p.Speed = current.Speed
		}
		if p.ETA == "" {
			p.ETA = current.ETA
		}
		if p.Total == "" {
			p.Total = current.Total
		}
	}
	mediaDownloads[url] = p
}

func getMediaProgress(url string) *mediaProgress {
	mediaProgressMu.Lock()
	defer mediaProgressMu.Unlock()
	return mediaDownloads[url]
}

func currentMediaPercent(url string) float64 {
	mediaProgressMu.Lock()
	defer mediaProgressMu.Unlock()
	if current := mediaDownloads[url]; current != nil {
		return current.Percent
	}
	return 0
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
				Percent: 98,
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
		Percent: 98,
		Status:  "ready",
	})
	return outputBuf.Bytes(), nil
}
