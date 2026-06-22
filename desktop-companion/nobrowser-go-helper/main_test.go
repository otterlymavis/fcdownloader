package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
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

func TestHelperPortDefaultsAndHonorsOverride(t *testing.T) {
	t.Setenv("FCDL_HELPER_PORT", "")
	if got := helperPort(); got != "8765" {
		t.Fatalf("default helper port = %q", got)
	}
	t.Setenv("FCDL_HELPER_PORT", "8766")
	if got := helperPort(); got != "8766" {
		t.Fatalf("override helper port = %q", got)
	}
	t.Setenv("FCDL_HELPER_PORT", "nope")
	if got := helperPort(); got != "8765" {
		t.Fatalf("invalid helper port should fall back, got %q", got)
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

func TestNightlyYtDlpAssetUsesWindowsExe(t *testing.T) {
	asset, err := platformNightlyYtDlpAsset("windows", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if asset.Filename != "yt-dlp.exe" {
		t.Fatalf("unexpected Windows nightly filename: %s", asset.Filename)
	}
	if asset.URL != "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe" {
		t.Fatalf("unexpected Windows nightly URL: %s", asset.URL)
	}
}

func TestYouTubeFailuresRetryWithNightly(t *testing.T) {
	if !shouldRetryWithNightly("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "ERROR: HTTP Error 403: Forbidden") {
		t.Fatal("YouTube 403 should trigger nightly fallback")
	}
	if !shouldRetryWithNightly("https://youtu.be/dQw4w9WgXcQ", "Requested format is not available") {
		t.Fatal("YouTube format breakage should trigger nightly fallback")
	}
	if shouldRetryWithNightly("https://example.com/video", "HTTP Error 403: Forbidden") {
		t.Fatal("non-YouTube failures should not trigger nightly fallback")
	}
}

func TestYtDlpDownloadArgsUseSteadierDefaults(t *testing.T) {
	t.Setenv("FCDL_YTDLP_CONCURRENT_FRAGMENTS", "")
	args := ytDlpDownloadArgs("best", "/tmp/ffmpeg", "/tmp/out", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "", false)
	joined := strings.Join(args, "\x00")
	for _, want := range []string{
		"--continue",
		"--retries\x00infinite",
		"--fragment-retries\x00infinite",
		"--file-access-retries\x005",
		"--retry-sleep\x003",
		"--socket-timeout\x0030",
		"--http-chunk-size\x0010M",
		"--concurrent-fragments\x004",
		"--extractor-args\x00youtube:player_client=default",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("download args missing %q: %#v", want, args)
		}
	}
	if strings.Contains(joined, "--no-part") {
		t.Fatalf("download args must preserve resumable partial files: %#v", args)
	}
}

func TestBilibiliDownloadArgsCarryHeadersAndCookies(t *testing.T) {
	args := ytDlpDownloadArgs("best", "/tmp/ffmpeg", "/tmp/out", "https://www.bilibili.com/video/BV1xx411c7mD/", "/tmp/cookies.txt", true)
	joined := strings.Join(args, "\x00")
	for _, want := range []string{
		"--ignore-config",
		"--referer\x00https://www.bilibili.com/",
		"--add-header\x00Origin:https://www.bilibili.com",
		"--cookies\x00/tmp/cookies.txt",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("Bilibili args missing %q: %#v", want, args)
		}
	}
}

func TestMediaFileCandidatesRejectJSONDisguisedAsMP4(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "metadata.mp4")
	good := filepath.Join(dir, "video.mp4")
	if err := os.WriteFile(bad, []byte(`{"code":-403,"message":"forbidden"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(good, append([]byte{0, 0, 0, 24}, []byte("ftypmp42")...), 0o644); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	candidates := mediaFileCandidates(dir, files)
	if len(candidates) != 1 || candidates[0] != good {
		t.Fatalf("expected only real media candidate, got %#v", candidates)
	}
}

func TestCookieFileFromHeaderMirrorsBilibiliDomains(t *testing.T) {
	path, cleanup, err := cookieFileFromHeader("SESSDATA=abc; bili_jct=def", "https://www.bilibili.com/video/BV1xx411c7mD/")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{".bilibili.com", ".bilivideo.com", "SESSDATA", "bili_jct"} {
		if !strings.Contains(text, want) {
			t.Fatalf("cookie file missing %q:\n%s", want, text)
		}
	}
}

func TestBilibiliAPIHelpersPickDashAndDurl(t *testing.T) {
	play := map[string]interface{}{
		"dash": map[string]interface{}{
			"video": []interface{}{
				map[string]interface{}{"baseUrl": "https://v-720.m4s", "height": float64(720), "codecs": "hev1", "bandwidth": float64(100)},
				map[string]interface{}{"baseUrl": "https://v-1080.m4s", "height": float64(1080), "codecs": "avc1.640028", "bandwidth": float64(200)},
			},
			"audio": []interface{}{
				map[string]interface{}{"baseUrl": "https://a-low.m4s", "bandwidth": float64(64)},
				map[string]interface{}{"baseUrl": "https://a-high.m4s", "bandwidth": float64(128)},
			},
		},
		"durl": []interface{}{
			map[string]interface{}{"url": "https://small.mp4", "size": float64(10)},
			map[string]interface{}{"url": "https://large.mp4", "size": float64(20)},
		},
	}
	video, audio := pickBilibiliDash(play, "1080", false)
	if video != "https://v-1080.m4s" || audio != "https://a-high.m4s" {
		t.Fatalf("unexpected DASH pick: video=%q audio=%q", video, audio)
	}
	video, _ = pickBilibiliDash(play, "720", false)
	if video != "https://v-720.m4s" {
		t.Fatalf("height cap should pick 720p, got %q", video)
	}
	previewOnly := map[string]interface{}{
		"dash": map[string]interface{}{
			"video": []interface{}{map[string]interface{}{"baseUrl": "https://preview-480.m4s", "height": float64(480)}},
			"audio": []interface{}{map[string]interface{}{"baseUrl": "https://audio.m4s", "bandwidth": float64(128)}},
		},
	}
	video, _ = pickBilibiliDash(previewOnly, "1080", true)
	if video != "" {
		t.Fatalf("clean HD selection must reject a 480p preview, got %q", video)
	}
	if got := pickBilibiliDurl(play); got != "https://large.mp4" {
		t.Fatalf("unexpected durl pick: %q", got)
	}
}

func TestBilibiliDashPrefersHighQualitySameHeight(t *testing.T) {
	play := map[string]interface{}{
		"dash": map[string]interface{}{
			"video": []interface{}{
				map[string]interface{}{"baseUrl": "https://v-2160.m4s", "id": float64(120), "height": float64(2160), "codecs": "hev1.2.4.L153", "bandwidth": float64(2_400_000)},
				map[string]interface{}{"baseUrl": "https://v-1080-small-avc.m4s", "id": float64(80), "height": float64(1080), "codecs": "avc1.640028", "bandwidth": float64(200_000)},
				map[string]interface{}{"baseUrl": "https://v-1080-large-hevc.m4s", "id": float64(112), "height": float64(1080), "codecs": "hev1.2.4.L153", "bandwidth": float64(1_400_000)},
			},
			"audio": []interface{}{
				map[string]interface{}{"baseUrl": "https://audio.m4s", "bandwidth": float64(128_000)},
			},
		},
	}
	video, audio := pickBilibiliDash(play, "", false)
	if video != "https://v-2160.m4s" || audio != "https://audio.m4s" {
		t.Fatalf("expected uncapped best Bilibili stream, got video=%q audio=%q", video, audio)
	}
	video, audio = pickBilibiliDash(play, "1080", false)
	if video != "https://v-1080-large-hevc.m4s" || audio != "https://audio.m4s" {
		t.Fatalf("expected largest same-height Bilibili stream, got video=%q audio=%q", video, audio)
	}
	candidates := bilibiliDashVideoCandidates(play, "bili-dash-v-80", "", false)
	if len(candidates) != 1 || firstString(candidates[0]["baseUrl"]) != "https://v-1080-small-avc.m4s" {
		t.Fatalf("expected selected Bilibili quality 80 only, got %+v", candidates)
	}
}

func TestBilibiliFormatsAreBestFirst(t *testing.T) {
	play := map[string]interface{}{
		"dash": map[string]interface{}{
			"video": []interface{}{
				map[string]interface{}{"baseUrl": "https://v-720.m4s", "id": float64(64), "height": float64(720), "codecs": "avc1.640028", "bandwidth": float64(800_000)},
				map[string]interface{}{"baseUrl": "https://v-1080-small-avc.m4s", "id": float64(80), "height": float64(1080), "codecs": "avc1.640028", "bandwidth": float64(200_000)},
				map[string]interface{}{"baseUrl": "https://v-1080-large-hevc.m4s", "id": float64(112), "height": float64(1080), "codecs": "hev1.2.4.L153", "bandwidth": float64(1_400_000)},
			},
			"audio": []interface{}{
				map[string]interface{}{"baseUrl": "https://audio.m4s", "id": float64(30280), "bandwidth": float64(128_000)},
			},
		},
	}
	formats := bilibiliFormatsFromPlay(play)
	if len(formats) == 0 {
		t.Fatal("expected Bilibili formats")
	}
	if formats[0].FormatID != "bili-dash-v-112" || numberValue(formats[0].Height) != 1080 {
		t.Fatalf("expected best Bilibili video first, got %+v", formats[0])
	}
}

func TestBilibiliTVCleanDashRequiresNoWatermarkFlag(t *testing.T) {
	play := map[string]interface{}{
		"accept_quality":     []interface{}{float64(80), float64(64)},
		"accept_watermark":   []interface{}{true, false},
		"accept_description": []interface{}{"高清 1080P", "高清 720P"},
		"dash": map[string]interface{}{
			"video": []interface{}{
				map[string]interface{}{"baseUrl": "https://watermarked-1080.m4s", "id": float64(80), "height": float64(1080), "codecs": "avc1.640033"},
				map[string]interface{}{"baseUrl": "https://clean-720.m4s", "id": float64(64), "height": float64(720), "codecs": "avc1.640033"},
			},
			"audio": []interface{}{
				map[string]interface{}{"baseUrl": "https://audio.m4s", "bandwidth": float64(128)},
			},
		},
	}
	video, audio := pickBilibiliTVCleanDash(play, "1080")
	if video != "https://clean-720.m4s" || audio != "https://audio.m4s" {
		t.Fatalf("expected only no-watermark TV quality, got video=%q audio=%q", video, audio)
	}
	play["accept_watermark"] = []interface{}{true, true}
	video, audio = pickBilibiliTVCleanDash(play, "1080")
	if video != "" || audio != "" {
		t.Fatalf("all-watermarked TV qualities must not be treated as clean: video=%q audio=%q", video, audio)
	}
}

func TestYouTubeHDFormatDoesNotSilentlyFallBackTo360p(t *testing.T) {
	if strings.Contains(youtubeFormat, "/18") || strings.Contains(youtubeFormat, "height<=360") || strings.Contains(youtubeFormat, "height<720") {
		t.Fatalf("youtube HD format should fail instead of silently downloading 360p: %q", youtubeFormat)
	}
	if !strings.Contains(youtubeFormat, "height<=1080") || !strings.Contains(youtubeFormat, "height>=720") {
		t.Fatalf("youtube HD format should explicitly stay in the HD range: %q", youtubeFormat)
	}
}

func TestMediaFileCandidatesIgnoreHTMLArtifacts(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "error.htm"), []byte(strings.Repeat("x", 200)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "video.mp4"), []byte("media"), 0o644); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	candidates := mediaFileCandidates(dir, files)
	if len(candidates) != 1 || filepath.Base(candidates[0]) != "video.mp4" {
		t.Fatalf("expected only media candidate, got %#v", candidates)
	}
}

func TestYtDlpPrimaryPathHonorsStableOverride(t *testing.T) {
	t.Setenv("FCDL_YTDLP_CHANNEL", "stable")
	t.Setenv("FCDL_YTDLP_EXE", "/tmp/custom-ytdlp")
	path, channel, err := ytDlpPrimaryPath(context.Background(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/tmp/custom-ytdlp" || channel != "stable" {
		t.Fatalf("unexpected yt-dlp primary selection: path=%q channel=%q", path, channel)
	}
}

func TestYtDlpPrimaryPathHonorsExplicitExecutable(t *testing.T) {
	t.Setenv("FCDL_YTDLP_EXE", "/tmp/custom-ytdlp")
	path, channel, err := ytDlpPrimaryPath(context.Background(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/tmp/custom-ytdlp" || channel != "stable" {
		t.Fatalf("explicit yt-dlp executable should win: path=%q channel=%q", path, channel)
	}
}

func TestDefaultYtDlpChannel(t *testing.T) {
	if got := defaultYtDlpChannel(); got != "auto" {
		t.Fatalf("default channel = %q, want auto", got)
	}
	t.Setenv("FCDL_YTDLP_CHANNEL", "stable")
	if got := defaultYtDlpChannel(); got != "stable" {
		t.Fatalf("stable channel = %q", got)
	}
	t.Setenv("FCDL_YTDLP_CHANNEL", "nightly")
	if got := defaultYtDlpChannel(); got != "nightly" {
		t.Fatalf("nightly channel = %q", got)
	}
	t.Setenv("FCDL_YTDLP_CHANNEL", "invalid")
	if got := defaultYtDlpChannel(); got != "auto" {
		t.Fatalf("invalid channel should fall back to auto, got %q", got)
	}
}

func TestToolStatusesIncludeNightlyYtDlp(t *testing.T) {
	t.Setenv("FCDL_HELPER_CACHE_DIR", t.TempDir())
	for _, path := range []string{stableYtDlpCachePath(), nightlyYtDlpCachePath()} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("tool"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	statuses := toolStatuses()
	found := map[string]bool{}
	for _, status := range statuses {
		found[status.Name] = status.Installed
	}
	if !found["yt-dlp"] {
		t.Fatalf("stable yt-dlp status missing or not installed: %+v", statuses)
	}
	if !found["yt-dlp-nightly"] {
		t.Fatalf("nightly yt-dlp status missing or not installed: %+v", statuses)
	}
	downloads := downloadedTools()
	if !downloads["yt-dlp"] || !downloads["yt-dlp-nightly"] {
		t.Fatalf("downloaded tools should report both yt-dlp channels: %+v", downloads)
	}
}

func TestToolsNeedSetupTreatsNightlyAsOptionalInAutoMode(t *testing.T) {
	tools := []toolStatus{
		{Name: "yt-dlp", Installed: true, Verified: true},
		{Name: "yt-dlp-nightly", Installed: false, Verified: false},
		{Name: "ffmpeg", Installed: true, Verified: true},
	}
	if toolsNeedSetupFromStatuses(tools) {
		t.Fatal("auto mode should not require nightly yt-dlp to be prewarmed")
	}
}

func TestToolsNeedSetupRequiresNightlyWhenForced(t *testing.T) {
	t.Setenv("FCDL_YTDLP_CHANNEL", "nightly")
	tools := []toolStatus{
		{Name: "yt-dlp", Installed: true, Verified: true},
		{Name: "yt-dlp-nightly", Installed: false, Verified: false},
		{Name: "ffmpeg", Installed: true, Verified: true},
	}
	if !toolsNeedSetupFromStatuses(tools) {
		t.Fatal("forced nightly mode should require nightly yt-dlp")
	}
}

func TestMediaProgressDoesNotMoveBackward(t *testing.T) {
	mediaProgressMu.Lock()
	mediaDownloads = make(map[string]*mediaProgress)
	mediaProgressMu.Unlock()

	const rawURL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
	setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 72, Speed: "1MiB/s", Total: "100MiB", Status: "downloading"})
	setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 15, Status: "downloading"})
	got := getMediaProgress(rawURL)
	if got.Percent != 72 {
		t.Fatalf("progress moved backward: %+v", got)
	}
	if got.Speed != "1MiB/s" || got.Total != "100MiB" {
		t.Fatalf("progress should preserve missing metadata: %+v", got)
	}
	setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 100, Status: "downloading"})
	got = getMediaProgress(rawURL)
	if got.Percent != 95 {
		t.Fatalf("downloading progress should be capped before merge: %+v", got)
	}
}

func TestCurrentMediaPercentUsesLatestProgress(t *testing.T) {
	mediaProgressMu.Lock()
	mediaDownloads = make(map[string]*mediaProgress)
	mediaProgressMu.Unlock()

	const rawURL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
	if got := currentMediaPercent(rawURL); got != 0 {
		t.Fatalf("missing progress percent = %v, want 0", got)
	}
	setMediaProgress(rawURL, &mediaProgress{URL: rawURL, Percent: 44, Status: "downloading"})
	if got := currentMediaPercent(rawURL); got != 44 {
		t.Fatalf("current progress percent = %v, want 44", got)
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

func TestCorsAllowsPrivateNetworkPreflight(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "http://127.0.0.1:8765/health", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("Origin", "chrome-extension://test-extension")
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	rec := httptest.NewRecorder()

	cors(http.HandlerFunc(handleHealth)).ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected preflight status %d, got %d", http.StatusNoContent, rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Private-Network"); got != "true" {
		t.Fatalf("expected private-network permission header, got %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "chrome-extension://test-extension" {
		t.Fatalf("expected explicit extension origin, got %q", got)
	}
}

func TestHealthReportsCompatibilityIdentity(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765/health", nil)
	rec := httptest.NewRecorder()

	handleHealth(rec, req)

	var health map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &health); err != nil {
		t.Fatalf("decode health response: %v", err)
	}
	if health["apiVersion"] != apiVersion {
		t.Fatalf("expected apiVersion %q, got %q", apiVersion, health["apiVersion"])
	}
	if health["variant"] != helperVariant {
		t.Fatalf("expected variant %q, got %q", helperVariant, health["variant"])
	}
	if health["buildId"] != buildID {
		t.Fatalf("expected buildId %q, got %q", buildID, health["buildId"])
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

func TestDownloadProgressEndpointReturnsExtractingState(t *testing.T) {
	const rawURL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
	setMediaProgress(rawURL, &mediaProgress{
		URL:     rawURL,
		Percent: 5,
		Status:  "extracting",
	})

	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765/download/progress?url="+url.QueryEscape(rawURL), nil)
	rr := httptest.NewRecorder()
	handleDownloadProgress(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}

	var body mediaProgress
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "extracting" || body.Percent != 5 {
		t.Fatalf("unexpected download progress payload: %+v", body)
	}
}
