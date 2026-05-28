package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAllowedURL(t *testing.T) {
	cases := []struct {
		name string
		url  string
		want bool
	}{
		{"https", "https://example.com/video.mp4", true},
		{"http", "http://example.com/watch?v=1", true},
		{"empty", "", false},
		{"ftp", "ftp://example.com/file.mp4", false},
		{"localhost", "http://localhost/video.mp4", false},
		{"loopback", "http://127.0.0.1/video.mp4", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := allowedURL(tc.url); got != tc.want {
				t.Fatalf("allowedURL(%q) = %v, want %v", tc.url, got, tc.want)
			}
		})
	}
}

func TestYouTubeURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://www.youtube.com/watch?v=dQw4w9WgXcQ", true},
		{"https://youtu.be/dQw4w9WgXcQ", true},
		{"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", true},
		{"https://example.com/watch?v=dQw4w9WgXcQ", false},
	}
	for _, tc := range cases {
		if got := youtubeURL(tc.url); got != tc.want {
			t.Fatalf("youtubeURL(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestSafeName(t *testing.T) {
	got := safeName(`hello:/\世界?.mp4`)
	if got != "hello______.mp4" {
		t.Fatalf("safeName returned %q", got)
	}
	if safeName("") != "fcdownloader-media" {
		t.Fatal("empty safeName did not use fallback")
	}
}

func TestPinnedTools(t *testing.T) {
	if toolPins.YtDlp.Version != "2026.03.17" {
		t.Fatalf("unexpected yt-dlp version pin: %s", toolPins.YtDlp.Version)
	}
	winYtDlp, err := platformYtDlpAsset("windows", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if winYtDlp.Filename != "yt-dlp.exe" || winYtDlp.SHA256 != "3db811b366b2da47337d2fcfdfe5bbd9a258dad3f350c54974f005df115a1545" {
		t.Fatalf("unexpected Windows yt-dlp asset: %+v", winYtDlp)
	}
	macYtDlp, err := platformYtDlpAsset("darwin", "arm64")
	if err != nil {
		t.Fatal(err)
	}
	if macYtDlp.Filename != "yt-dlp_macos" || macYtDlp.SHA256 != "e80c47b3ce712acee51d5e3d4eace2d181b44d38f1942c3a32e3c7ff53cd9ed5" {
		t.Fatalf("unexpected macOS yt-dlp asset: %+v", macYtDlp)
	}
	winFFmpeg, err := platformFFmpegAsset("windows", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if winFFmpeg.Filename != "ffmpeg-win-x86_64-v7.1.exe" || winFFmpeg.SHA256 == "" {
		t.Fatalf("unexpected Windows ffmpeg asset: %+v", winFFmpeg)
	}
	macFFmpeg, err := platformFFmpegAsset("darwin", "arm64")
	if err != nil {
		t.Fatal(err)
	}
	if macFFmpeg.Filename != "ffmpeg-macos-aarch64-v7.1" {
		t.Fatalf("unexpected macOS ffmpeg asset: %+v", macFFmpeg)
	}
	if toolExecutableName("yt-dlp", "darwin") != "yt-dlp" {
		t.Fatal("macOS yt-dlp cache name should not use .exe")
	}
	if toolExecutableName("yt-dlp", "windows") != "yt-dlp.exe" {
		t.Fatal("Windows yt-dlp cache name should use .exe")
	}
}

func TestCachedToolValidRemovesChecksumMismatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tool")
	if err := os.WriteFile(path, []byte("stale"), 0o755); err != nil {
		t.Fatal(err)
	}
	if cachedToolValid(path, "0000000000000000000000000000000000000000000000000000000000000000") {
		t.Fatal("cache entry with mismatched checksum should not be valid")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stale cache entry should be removed, stat err=%v", err)
	}
}

func TestStatusForToolReportsCorruptedFFmpegCache(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ffmpeg-win-x86_64-v7.1.exe")
	if err := os.WriteFile(path, []byte("corrupt"), 0o755); err != nil {
		t.Fatal(err)
	}
	asset, err := platformFFmpegAsset("windows", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	status := statusForTool("ffmpeg", path, asset)
	if !status.Installed {
		t.Fatal("corrupted ffmpeg cache should still report installed")
	}
	if status.Verified {
		t.Fatal("corrupted ffmpeg cache should report unverified")
	}
}

func TestCachedToolValidAcceptsMatchingChecksum(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tool")
	if err := os.WriteFile(path, []byte("ok"), 0o755); err != nil {
		t.Fatal(err)
	}
	const okSHA256 = "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df"
	if !cachedToolValid(path, okSHA256) {
		t.Fatal("cache entry with matching checksum should be valid")
	}
}

func TestLocalHostAndOptionalTokenGuards(t *testing.T) {
	if !validLocalHost("127.0.0.1:8765") {
		t.Fatal("loopback host should be valid")
	}
	if !validLocalHost("localhost:8765") {
		t.Fatal("localhost should be valid")
	}
	if validLocalHost("example.com:8765") {
		t.Fatal("non-local host header should be rejected")
	}
	t.Setenv("FCDL_HELPER_TOKEN", "secret")
	req := httptest.NewRequest("GET", "http://127.0.0.1:8765/health", nil)
	if authorizedLocalRequest(req) {
		t.Fatal("missing token should be rejected when token env is set")
	}
	req.Header.Set("X-FCDL-Helper-Token", "secret")
	if !authorizedLocalRequest(req) {
		t.Fatal("matching token header should be accepted")
	}
}

func TestRateLimit(t *testing.T) {
	limitMu.Lock()
	limitHits = map[string][]time.Time{}
	limitMu.Unlock()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765/health", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	for i := 0; i < maxRequestsPerMinute; i++ {
		if !rateLimitOK(req) {
			t.Fatalf("request %d should be allowed", i)
		}
	}
	if rateLimitOK(req) {
		t.Fatal("request over per-minute limit should be rejected")
	}
}

func TestToolsProgressEndpoint(t *testing.T) {
	setProgress(progressState{
		Active:     true,
		Tool:       "yt-dlp",
		URL:        "https://example.com/yt-dlp.exe",
		Downloaded: 25,
		Total:      100,
		Attempt:    2,
		Message:    "downloading",
	})

	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765/tools/progress", nil)
	rr := httptest.NewRecorder()
	handleToolsProgress(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}

	var body struct {
		OK       bool          `json:"ok"`
		Progress progressState `json:"progress"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.OK {
		t.Fatal("progress response should be ok")
	}
	if body.Progress.Tool != "yt-dlp" || body.Progress.Downloaded != 25 || body.Progress.Total != 100 || body.Progress.Attempt != 2 {
		t.Fatalf("unexpected progress payload: %+v", body.Progress)
	}
	if body.Progress.UpdatedAt == "" {
		t.Fatal("progress response should include updatedAt")
	}
}
