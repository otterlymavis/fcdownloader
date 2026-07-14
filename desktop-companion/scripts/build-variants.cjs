const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const COMPANION_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(COMPANION_ROOT, "..");
const BUILD_ROOT = path.join(COMPANION_ROOT, "build");
const HELPER_EXE = path.join(BUILD_ROOT, "helper", "fcdownloader-local-helper.exe");
const HELPER_SCRIPT = path.join(REPO_ROOT, "scripts", "local-youtube-helper.py");
const DIST_LITE = path.join(COMPANION_ROOT, process.env.FCDL_LITE_DIST || "dist-lite-ver");
const DIST_NOBROWSER = path.join(COMPANION_ROOT, "dist-nobrowser-ver");
const DIST_NOBROWSER_GO = path.join(COMPANION_ROOT, "dist-nobrowser-go-ver");
const DIST_NOBROWSER_GO_MAC = path.join(COMPANION_ROOT, "dist-nobrowser-go-mac");
const VERSION = require(path.join(COMPANION_ROOT, "package.json")).version;
const RELEASE = require(path.join(REPO_ROOT, "release.json"));
const HELPER_BUILD_ID = process.env.FCDL_HELPER_BUILD_ID || `${VERSION}-${Date.now()}`;
const HELPER_BUILD = (process.env.FCDL_HELPER_BUILD || HELPER_BUILD_ID).trim() || HELPER_BUILD_ID;
const MINIMUM_EXTENSION_BUILD = (process.env.FCDL_MIN_EXTENSION_BUILD || RELEASE.extension).trim() || RELEASE.extension;
const HELPER_LDFLAGS = [
  "-s",
  "-w",
  `-X main.serviceVersion=${RELEASE.localHelperVersion}`,
  `-X main.apiVersion=${RELEASE.localHelperApi}`,
  `-X main.buildID=${HELPER_BUILD_ID}`,
  `-X main.helperBuild=${HELPER_BUILD}`,
  `-X main.minimumExtensionBuild=${MINIMUM_EXTENSION_BUILD}`,
].join(" ");
const NOBROWSER_LAUNCHER = path.join(BUILD_ROOT, "nobrowser", "FCDownloaderCompanionNoBrowser.exe");
const NOBROWSER_GO_HELPER = path.join(BUILD_ROOT, "nobrowser-go", "FCDownloaderNativeHelper.exe");
const NOBROWSER_GO_TRAY = path.join(BUILD_ROOT, "nobrowser-go", "FCDownloaderCompanionTray.exe");

function run(command, args, options = {}) {
  console.log(`[variants] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || COMPANION_ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function runOptional(command, args, options = {}) {
  if (!options.enabled) return false;
  run(command, args, options);
  return true;
}

function ensureHelper() {
  run(process.execPath, [path.join(COMPANION_ROOT, "scripts", "build-helper.cjs")]);
  if (!fs.existsSync(HELPER_EXE)) {
    throw new Error(`Missing helper executable: ${HELPER_EXE}`);
  }
}

function buildLiteElectron() {
  const cli = path.join(COMPANION_ROOT, "node_modules", "electron-builder", "cli.js");
  fs.rmSync(DIST_LITE, { recursive: true, force: true });
  run(process.execPath, [
    cli,
    "--win",
    "nsis",
    "--x64",
    `--config.directories.output=${path.basename(DIST_LITE)}`,
    "--config.productName=FCDownloader Companion Lite",
    "--config.artifactName=FCDownloader Companion Lite Setup ${version}.${ext}",
    "--config.compression=maximum",
    "--config.electronLanguages=en-US",
    "--config.win.signAndEditExecutable=false",
  ], {
    env: {
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_CACHE: path.join(BUILD_ROOT, "electron-cache"),
      ELECTRON_BUILDER_CACHE: path.join(BUILD_ROOT, "electron-builder-cache"),
    },
  });
}

function findMakeNsis() {
  const root = path.join(BUILD_ROOT, "electron-builder-cache", "nsis");
  const windowsNsis = [
    "C:\\Program Files (x86)\\NSIS\\makensis.exe",
    "C:\\Program Files\\NSIS\\makensis.exe",
  ];
  for (const candidate of windowsNsis) {
    if (process.platform === "win32" && fs.existsSync(candidate)) return candidate;
  }
  if (!fs.existsSync(root)) {
    try {
      const result = spawnSync(process.platform === "win32" ? "where" : "which", ["makensis"], { shell: false });
      if (result.status === 0) return "makensis";
    } catch (e) {}
    return null;
  }
  const candidates = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase() === "makensis.exe" || entry.name.toLowerCase() === "makensis") candidates.push(full);
    }
  }
  walk(root);
  const direct = candidates.find((candidate) => path.basename(path.dirname(candidate)).toLowerCase() !== "bin");
  return direct || candidates[0] || null;
}

function findGo() {
  const configured = process.env.FCDL_GO;
  if (configured && fs.existsSync(configured)) return configured;
  const fresh = path.join(BUILD_ROOT, "toolchains", "go-fresh", "go", "bin", "go.exe");
  if (fs.existsSync(fresh)) return fresh;
  const local = path.join(BUILD_ROOT, "toolchains", "go", "bin", "go.exe");
  if (fs.existsSync(local)) return local;
  return "go";
}

function escapeNsis(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '$\\"');
}

function plistEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function macBundleId(arch) {
  return `com.fcdownloader.nativehelper.${arch}`;
}

function copyMacIcon(resourcesDir) {
  const icnsPath = path.join(COMPANION_ROOT, "assets", "icon.icns");
  if (fs.existsSync(icnsPath)) {
    fs.copyFileSync(icnsPath, path.join(resourcesDir, "icon.icns"));
    return "icon.icns";
  }
  const pngPath = path.join(COMPANION_ROOT, "assets", "icon.png");
  if (fs.existsSync(pngPath)) fs.copyFileSync(pngPath, path.join(resourcesDir, "icon.png"));
  return "icon.png";
}

function writeMacAppBundle(appDir, helperBin, arch) {
  const contentsDir = path.join(appDir, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.copyFileSync(helperBin, path.join(macosDir, "FCDownloaderNativeHelper"));
  const iconFile = copyMacIcon(resourcesDir);
  fs.writeFileSync(path.join(contentsDir, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>FCDownloader Native Helper</string>
  <key>CFBundleExecutable</key>
  <string>FCDownloaderNativeHelper</string>
  <key>CFBundleIdentifier</key>
  <string>${plistEscape(macBundleId(arch))}</string>
  <key>CFBundleName</key>
  <string>FCDownloader Native Helper</string>
  <key>CFBundleIconFile</key>
  <string>${iconFile}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>FCDownloader Companion</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>fcdownloader-companion</string>
      </array>
    </dict>
  </array>
  <key>CFBundleShortVersionString</key>
  <string>${plistEscape(VERSION)}</string>
  <key>CFBundleVersion</key>
  <string>${plistEscape(VERSION)}</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`, "utf8");
  fs.writeFileSync(path.join(resourcesDir, "README.txt"), [
    "FCDownloader Native Helper for macOS",
    "",
    "Double-click the app to start the local helper.",
    "The helper listens on http://127.0.0.1:8765.",
    "Logs are written to ~/Library/Caches/FCDownloader/logs/native-helper.log.",
    "",
    "If macOS blocks this unsigned development build, right-click the app and choose Open, or use a signed/notarized release build.",
    "",
  ].join("\n"), "utf8");
}

function maybeSignAndNotarizeMacApp(appDir) {
  if (process.platform !== "darwin") return;
  const identity = process.env.FCDL_MAC_SIGN_IDENTITY;
  if (identity) {
    runOptional("codesign", [
      "--force",
      "--deep",
      "--timestamp",
      "--options",
      "runtime",
      "--sign",
      identity,
      appDir,
    ], { enabled: true });
  }
  if (identity && process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) {
    const zipPath = `${appDir}.notary.zip`;
    run("ditto", ["-c", "-k", "--keepParent", appDir, zipPath]);
    run("xcrun", [
      "notarytool",
      "submit",
      zipPath,
      "--apple-id",
      process.env.APPLE_ID,
      "--password",
      process.env.APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id",
      process.env.APPLE_TEAM_ID,
      "--wait",
    ]);
    run("xcrun", ["stapler", "staple", appDir]);
  }
}

function archiveMacPackage(sourceDir, outPath) {
  if (process.platform === "darwin") {
    run("ditto", ["-c", "-k", "--keepParent", sourceDir, outPath]);
    return;
  }
  run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${outPath}' -Force`,
  ]);
}

function writeExecutableText(filePath, text) {
  fs.writeFileSync(filePath, text, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function writeMacActionApp(outDir, name, script, bundleSuffix) {
  const appDir = path.join(outDir, `${name}.app`);
  const contentsDir = path.join(appDir, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  const executable = "action";
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  writeExecutableText(path.join(macosDir, executable), script);
  const iconFile = copyMacIcon(resourcesDir);
  fs.writeFileSync(path.join(contentsDir, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${plistEscape(name)}</string>
  <key>CFBundleExecutable</key>
  <string>${executable}</string>
  <key>CFBundleIdentifier</key>
  <string>com.fcdownloader.nativehelper.action.${plistEscape(bundleSuffix)}</string>
  <key>CFBundleName</key>
  <string>${plistEscape(name)}</string>
  <key>CFBundleIconFile</key>
  <string>${iconFile}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`, "utf8");
}

function writeMacUserScripts(outDir) {
  writeMacActionApp(outDir, "Start FCDownloader Helper", `#!/bin/bash
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
open "$ROOT/FCDownloader Native Helper.app"
osascript -e 'display notification "FCDownloader Helper is starting." with title "FCDownloader"'
`, "start");

  writeMacActionApp(outDir, "Stop FCDownloader Helper", `#!/bin/bash
pkill -f "FCDownloaderNativeHelper" 2>/dev/null || true
pkill -f "fcdownloader-local-helper" 2>/dev/null || true
pkill -f "local-youtube-helper.py" 2>/dev/null || true
osascript -e 'display notification "FCDownloader Helper has stopped." with title "FCDownloader"'
`, "stop");

  writeMacActionApp(outDir, "Check Helper Status", `#!/bin/bash
if curl -fsS --max-time 3 "http://127.0.0.1:8765/health"; then
  osascript -e 'display dialog "FCDownloader Helper is ready." buttons {"OK"} default button "OK" with title "FCDownloader"'
else
  osascript -e 'display dialog "FCDownloader Helper is not running." buttons {"OK"} default button "OK" with title "FCDownloader"'
fi
`, "status");

  writeMacActionApp(outDir, "Open Helper Log", `#!/bin/bash
LOG="$HOME/Library/Caches/FCDownloader/logs/native-helper.log"
mkdir -p "$(dirname "$LOG")"
touch "$LOG"
open "$LOG"
`, "log");

  writeMacActionApp(outDir, "Open Helper Cache", `#!/bin/bash
DIR="$HOME/Library/Caches/FCDownloader"
mkdir -p "$DIR"
open "$DIR"
`, "cache");
}

function buildNoBrowser() {
  fs.rmSync(DIST_NOBROWSER, { recursive: true, force: true });
  fs.mkdirSync(DIST_NOBROWSER, { recursive: true });
  fs.mkdirSync(path.dirname(NOBROWSER_LAUNCHER), { recursive: true });

  run(findGo(), [
    "build",
    "-trimpath",
    "-ldflags",
    "-H=windowsgui -s -w",
    "-o",
    NOBROWSER_LAUNCHER,
    ".",
  ], {
    cwd: path.join(COMPANION_ROOT, "nobrowser-launcher"),
    env: {
      CGO_ENABLED: "0",
      GO111MODULE: "off",
      GOOS: "windows",
      GOARCH: "amd64",
      GOCACHE: path.join(BUILD_ROOT, "go-cache"),
      GOMODCACHE: path.join(BUILD_ROOT, "go-mod-cache"),
    },
  });

  const nsiPath = path.join(BUILD_ROOT, "nobrowser-ver.nsi");
  const outPath = path.join(DIST_NOBROWSER, `FCDownloader Companion NoBrowser Setup ${VERSION}.exe`);
  const script = `
Unicode true
SetCompressor /SOLID lzma
Name "FCDownloader Companion NoBrowser"
OutFile "${escapeNsis(outPath)}"
InstallDir "$LOCALAPPDATA\\Programs\\FCDownloader Companion NoBrowser"
RequestExecutionLevel user
ShowInstDetails nevershow
ShowUninstDetails nevershow

Section "Install"
  SetOutPath "$INSTDIR"
  File /oname=FCDownloaderCompanionNoBrowser.exe "${escapeNsis(NOBROWSER_LAUNCHER)}"
  File /oname=fcdownloader-local-helper.exe "${escapeNsis(HELPER_EXE)}"
  File /oname=local-youtube-helper.py "${escapeNsis(HELPER_SCRIPT)}"
  WriteRegStr HKCU "Software\\Classes\\fcdownloader-companion-legacy" "" "URL:FCDownloader Legacy Companion Protocol"
  WriteRegStr HKCU "Software\\Classes\\fcdownloader-companion-legacy" "URL Protocol" ""
  WriteRegStr HKCU "Software\\Classes\\fcdownloader-companion-legacy\\shell\\open\\command" "" '"$INSTDIR\\FCDownloaderCompanionNoBrowser.exe" "%1"'
  CreateDirectory "$SMPROGRAMS\\FCDownloader"
  CreateShortCut "$SMPROGRAMS\\FCDownloader\\Companion NoBrowser.lnk" "$INSTDIR\\FCDownloaderCompanionNoBrowser.exe"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
SectionEnd

Section "Uninstall"
  ReadRegStr $0 HKCU "Software\\Classes\\fcdownloader-companion-legacy\\shell\\open\\command" ""
  StrCmp $0 '"$INSTDIR\\FCDownloaderCompanionNoBrowser.exe" "%1"' 0 +2
  DeleteRegKey HKCU "Software\\Classes\\fcdownloader-companion-legacy"
  Delete "$SMPROGRAMS\\FCDownloader\\Companion NoBrowser.lnk"
  RMDir "$SMPROGRAMS\\FCDownloader"
  Delete "$INSTDIR\\FCDownloaderCompanionNoBrowser.exe"
  Delete "$INSTDIR\\fcdownloader-local-helper.exe"
  Delete "$INSTDIR\\local-youtube-helper.py"
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
`;
  fs.writeFileSync(nsiPath, script.trimStart(), "utf8");
  const makeNsis = findMakeNsis();
  if (makeNsis) {
    run(makeNsis, [process.platform === "win32" ? "/V2" : "-V2", nsiPath]);
  } else {
    console.warn("[variants] Warning: makensis not found. Skipping NSIS installer generation.");
  }
}

function buildNoBrowserGo() {
  fs.rmSync(DIST_NOBROWSER_GO, { recursive: true, force: true });
  fs.rmSync(DIST_NOBROWSER_GO_MAC, { recursive: true, force: true });
  fs.mkdirSync(DIST_NOBROWSER_GO, { recursive: true });
  fs.mkdirSync(DIST_NOBROWSER_GO_MAC, { recursive: true });
  fs.mkdirSync(path.dirname(NOBROWSER_GO_HELPER), { recursive: true });

  run(findGo(), [
    "build",
    "-trimpath",
    "-ldflags",
    HELPER_LDFLAGS,
    "-o",
    NOBROWSER_GO_HELPER,
    ".",
  ], {
    cwd: path.join(COMPANION_ROOT, "nobrowser-go-helper"),
    env: {
      CGO_ENABLED: "0",
      GO111MODULE: "off",
      GOOS: "windows",
      GOARCH: "amd64",
      GOCACHE: path.join(BUILD_ROOT, "go-cache"),
      GOMODCACHE: path.join(BUILD_ROOT, "go-mod-cache"),
    },
  });

  run(findGo(), [
    "build",
    "-trimpath",
    "-ldflags",
    "-H=windowsgui -s -w",
    "-o",
    NOBROWSER_GO_TRAY,
    ".",
  ], {
    cwd: path.join(COMPANION_ROOT, "nobrowser-go-tray"),
    env: {
      CGO_ENABLED: "0",
      GO111MODULE: "off",
      GOOS: "windows",
      GOARCH: "amd64",
      GOCACHE: path.join(BUILD_ROOT, "go-cache"),
      GOMODCACHE: path.join(BUILD_ROOT, "go-mod-cache"),
    },
  });

  for (const arch of ["amd64", "arm64"]) {
    const outDir = path.join(DIST_NOBROWSER_GO_MAC, `FCDownloaderNativeHelper-darwin-${arch}-${VERSION}`);
    const outBin = path.join(outDir, "FCDownloaderNativeHelper");
    const appDir = path.join(outDir, "FCDownloader Native Helper.app");
    fs.mkdirSync(outDir, { recursive: true });
    run(findGo(), [
      "build",
      "-trimpath",
      "-ldflags",
      HELPER_LDFLAGS,
      "-o",
      outBin,
      ".",
    ], {
      cwd: path.join(COMPANION_ROOT, "nobrowser-go-helper"),
      env: {
        CGO_ENABLED: "0",
        GO111MODULE: "off",
        GOOS: "darwin",
        GOARCH: arch,
        GOCACHE: path.join(BUILD_ROOT, "go-cache"),
        GOMODCACHE: path.join(BUILD_ROOT, "go-mod-cache"),
      },
    });
    writeMacAppBundle(appDir, outBin, arch);
    maybeSignAndNotarizeMacApp(appDir);
    writeMacUserScripts(outDir);
    fs.writeFileSync(path.join(outDir, "README.txt"), [
      "FCDownloader Native Helper for macOS",
      "",
      "For most people:",
      "  1. Double-click Start FCDownloader Helper.app.",
      "  2. Use the FCDownloader browser extension.",
      "  3. Double-click Stop FCDownloader Helper.app only when you want to turn it off.",
      "",
      "Useful icon apps in this folder:",
      "  Start FCDownloader Helper.app - starts the background helper.",
      "  Stop FCDownloader Helper.app - stops the helper.",
      "  Check Helper Status.app - tells you whether it is ready.",
      "  Open Helper Log.app - opens the troubleshooting log.",
      "  Open Helper Cache.app - opens downloaded video tool files.",
      "",
      "Advanced Terminal fallback:",
      "  chmod +x ./FCDownloaderNativeHelper",
      "  ./FCDownloaderNativeHelper",
      "",
      "The helper listens on http://127.0.0.1:8765 and downloads pinned yt-dlp/ffmpeg assets into the user cache on first use.",
      "Set FCDL_MAC_SIGN_IDENTITY plus APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID on macOS to sign/notarize release builds.",
      "",
    ].join("\n"), "utf8");
    archiveMacPackage(outDir, `${outDir}.zip`);
  }

  const nsiPath = path.join(BUILD_ROOT, "nobrowser-go-ver.nsi");
  const outPath = path.join(DIST_NOBROWSER_GO, `FCDownloader Companion NoBrowser Go Setup ${VERSION}.exe`);
  const script = `
Unicode true
!include MUI2.nsh
SetCompressor /SOLID lzma
Name "FCDownloader Companion NoBrowser Go"
OutFile "${escapeNsis(outPath)}"
InstallDir "$LOCALAPPDATA\\Programs\\FCDownloader Companion NoBrowser Go"
RequestExecutionLevel user
ShowInstDetails nevershow
ShowUninstDetails nevershow
BrandingText "Downloads video tools on first use."

!define MUI_WELCOMEPAGE_TITLE "Install FCDownloader Companion NoBrowser Go"
!define MUI_WELCOMEPAGE_TEXT "This tiny Windows helper lets the extension and web app use local video tools. It downloads video tools on first use, then caches them for offline reuse."
!define MUI_COMPONENTSPAGE_TEXT_TOP "Choose whether FCDownloader Companion should start automatically when you sign in."
!define MUI_FINISHPAGE_RUN "$INSTDIR\\FCDownloaderCompanionTray.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Companion now"
!define MUI_FINISHPAGE_TEXT "The companion is installed. yt-dlp and ffmpeg will be downloaded and cached on first use."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "FCDownloader Companion NoBrowser Go"
VIAddVersionKey "CompanyName" "FCDownloader"
VIAddVersionKey "FileDescription" "FCDownloader tiny local companion installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright FCDownloader"

Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /oname=FCDownloaderNativeHelper.exe "${escapeNsis(NOBROWSER_GO_HELPER)}"
  File /oname=FCDownloaderCompanionTray.exe "${escapeNsis(NOBROWSER_GO_TRAY)}"
  WriteRegStr HKCU "Software\\Classes\\fcdownloader-companion" "" "URL:FCDownloader Companion Protocol"
  WriteRegStr HKCU "Software\\Classes\\fcdownloader-companion" "URL Protocol" ""
  WriteRegStr HKCU "Software\\Classes\\fcdownloader-companion" "Owner" "nobrowser-go"
  WriteRegStr HKCU "Software\\Classes\\fcdownloader-companion\\shell\\open\\command" "" '"$INSTDIR\\FCDownloaderCompanionTray.exe" "%1"'
  CreateDirectory "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Start Companion.lnk" "$INSTDIR\\FCDownloaderCompanionTray.exe"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Companion NoBrowser Go.lnk" "$INSTDIR\\FCDownloaderCompanionTray.exe"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Companion NoBrowser Go Status.lnk" "$INSTDIR\\FCDownloaderCompanionTray.exe" "--status"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Install Video Tools.lnk" "$INSTDIR\\FCDownloaderCompanionTray.exe" "--ensure-tools"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Stop Companion.lnk" "$INSTDIR\\FCDownloaderCompanionTray.exe" "--stop"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Stop Companion Helper.lnk" "$INSTDIR\\FCDownloaderCompanionTray.exe" "--stop"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Open Logs.lnk" "$INSTDIR\\FCDownloaderCompanionTray.exe" "--open-log"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Open Companion Logs.lnk" "$INSTDIR\\FCDownloaderCompanionTray.exe" "--open-log"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Open Companion Cache.lnk" "$INSTDIR\\FCDownloaderCompanionTray.exe" "--open-cache"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Mirror Settings.lnk" "$INSTDIR\\FCDownloaderCompanionTray.exe" "--open-config"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Uninstall.lnk" "$INSTDIR\\Uninstall.exe"
  CreateShortCut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Uninstall Companion NoBrowser Go.lnk" "$INSTDIR\\Uninstall.exe"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
SectionEnd

Section /o "Run Companion on login" SecRunAtLogin
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "FCDownloaderCompanion" '"$INSTDIR\\FCDownloaderCompanionTray.exe"'
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ReadRegStr $0 HKCU "Software\\Classes\\fcdownloader-companion\\shell\\open\\command" ""
  StrCmp $0 '"$INSTDIR\\FCDownloaderCompanionTray.exe" "%1"' 0 +2
  DeleteRegKey HKCU "Software\\Classes\\fcdownloader-companion"
  ReadRegStr $0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "FCDownloaderCompanion"
  StrCmp $0 '"$INSTDIR\\FCDownloaderCompanionTray.exe"' 0 +2
  DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "FCDownloaderCompanion"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Start Companion.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Companion NoBrowser Go.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Companion NoBrowser Go Status.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Install Video Tools.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Stop Companion.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Stop Companion Helper.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Open Logs.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Open Companion Logs.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Open Companion Cache.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Mirror Settings.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Uninstall.lnk"
  Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader\\Uninstall Companion NoBrowser Go.lnk"
  RMDir "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\FCDownloader"
  Delete "$INSTDIR\\FCDownloaderCompanionTray.exe"
  Delete "$INSTDIR\\FCDownloaderNativeHelper.exe"
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
`;
  fs.writeFileSync(nsiPath, script.trimStart(), "utf8");
  const makeNsis = findMakeNsis();
  if (makeNsis) {
    run(makeNsis, [process.platform === "win32" ? "/V2" : "-V2", nsiPath]);
  } else {
    console.warn("[variants] Warning: makensis not found. Skipping NSIS installer generation.");
  }
}

const requested = new Set(process.argv.slice(2));
const buildAll = requested.size === 0 || requested.has("all");

if (buildAll || requested.has("lite") || requested.has("nobrowser")) ensureHelper();
if (buildAll || requested.has("lite")) buildLiteElectron();
if (buildAll || requested.has("nobrowser")) buildNoBrowser();
if (buildAll || requested.has("nobrowser-go")) buildNoBrowserGo();
