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
  const candidates = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase() === "makensis.exe") candidates.push(full);
    }
  }
  walk(root);
  const direct = candidates.find((candidate) => path.basename(path.dirname(candidate)).toLowerCase() !== "bin");
  return direct || candidates[0];
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

function writeMacAppBundle(appDir, helperBin, arch) {
  const contentsDir = path.join(appDir, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.copyFileSync(helperBin, path.join(macosDir, "FCDownloaderNativeHelper"));
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
  <key>CFBundlePackageType</key>
  <string>APPL</string>
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
  WriteRegStr HKCU "Software\\Classes\\fcdownloader-companion" "" "URL:FCDownloader Companion Protocol"
  WriteRegStr HKCU "Software\\Classes\\fcdownloader-companion" "URL Protocol" ""
  WriteRegStr HKCU "Software\\Classes\\fcdownloader-companion\\shell\\open\\command" "" '"$INSTDIR\\FCDownloaderCompanionNoBrowser.exe" "%1"'
  CreateDirectory "$SMPROGRAMS\\FCDownloader"
  CreateShortCut "$SMPROGRAMS\\FCDownloader\\Companion NoBrowser.lnk" "$INSTDIR\\FCDownloaderCompanionNoBrowser.exe"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
SectionEnd

Section "Uninstall"
  DeleteRegKey HKCU "Software\\Classes\\fcdownloader-companion"
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
  run(findMakeNsis(), ["/V2", nsiPath]);
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
    "-s -w",
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
      "-s -w",
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
    fs.writeFileSync(path.join(outDir, "README.txt"), [
      "FCDownloader Native Helper for macOS",
      "",
      "Preferred: open FCDownloader Native Helper.app.",
      "",
      "Terminal fallback:",
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
  DeleteRegKey HKCU "Software\\Classes\\fcdownloader-companion"
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
  run(findMakeNsis(), ["/V2", nsiPath]);
}

const requested = new Set(process.argv.slice(2));
const buildAll = requested.size === 0 || requested.has("all");

if (buildAll || requested.has("lite") || requested.has("nobrowser")) ensureHelper();
if (buildAll || requested.has("lite")) buildLiteElectron();
if (buildAll || requested.has("nobrowser")) buildNoBrowser();
if (buildAll || requested.has("nobrowser-go")) buildNoBrowserGo();
