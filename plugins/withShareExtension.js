/**
 * Expo Config Plugin — iOS Share Extension
 * iOS only — returns config unchanged on Android.
 */
// @ts-check
const { withXcodeProject, withEntitlementsPlist, createRunOncePlugin } = require('@expo/config-plugins');
const fs   = require('fs');
const path = require('path');

const EXT_NAME      = 'ShareExtension';
const BUNDLE_ID     = 'com.otterpia.fcdownloader';
const EXT_BUNDLE_ID = `${BUNDLE_ID}.ShareExtension`;
const APP_GROUP     = `group.${BUNDLE_ID}`;
const APP_SCHEME    = 'fcdownloader';
const DEPLOYMENT_TARGET = '15.1';
const VERSION = '1.5.20';
const BUILD_NUMBER = '26';

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

// ── Swift source ───────────────────────────────────────────────────────────────

const SHARE_VIEW_CONTROLLER = `\
import UIKit
import UniformTypeIdentifiers
import MobileCoreServices

class ShareViewController: UIViewController {

    private let appGroupId = "${APP_GROUP}"
    private let appScheme  = "${APP_SCHEME}"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0)
        extractURL { [weak self] url in
            DispatchQueue.main.async {
                guard let self else { return }
                if let url = url { self.showSheet(for: url) }
                else             { self.showNoLinkAlert() }
            }
        }
    }

    private func firstURL(from text: String?) -> URL? {
        guard var value = text?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }

        let pattern = #"https?://[^\\s<>"'\`\\\\]+"#
        if let range = value.range(of: pattern, options: .regularExpression) {
            value = String(value[range])
        }

        value = value.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?)\\\\]}>'\\""))
        return URL(string: value)
    }

    private func extractURL(completion: @escaping (URL?) -> Void) {
        guard let item = extensionContext?.inputItems.first as? NSExtensionItem else {
            return completion(nil)
        }
        if let url = firstURL(from: item.attributedContentText?.string)
            ?? firstURL(from: item.attributedTitle?.string) {
            return completion(url)
        }
        let typeIds: [String]
        if #available(iOS 14.0, *) {
            typeIds = [UTType.url.identifier, UTType.plainText.identifier, UTType.text.identifier]
        } else {
            typeIds = [kUTTypeURL as String, kUTTypePlainText as String, kUTTypeText as String]
        }
        var candidates: [(NSItemProvider, String)] = []
        for attachment in item.attachments ?? [] {
            for typeId in typeIds {
                guard attachment.hasItemConformingToTypeIdentifier(typeId) else { continue }
                candidates.append((attachment, typeId))
            }
        }

        func loadCandidate(at index: Int) {
            guard index < candidates.count else { return completion(nil) }
            let (attachment, typeId) = candidates[index]
            attachment.loadItem(forTypeIdentifier: typeId) { obj, _ in
                let url: URL?
                if      let obj = obj as? URL      { url = obj }
                else if let obj = obj as? NSURL    { url = obj as URL }
                else if let obj = obj as? String   { url = self.firstURL(from: obj) }
                else if let obj = obj as? NSString { url = self.firstURL(from: obj as String) }
                else                               { url = nil }

                if let url { completion(url) }
                else       { loadCandidate(at: index + 1) }
            }
        }

        loadCandidate(at: 0)
    }

    private func showSheet(for url: URL) {
        let urlStr  = url.absoluteString
        let preview = urlStr.count > 80 ? String(urlStr.prefix(80)) + "..." : urlStr
        let sheet   = UIAlertController(title: "FC Downloader", message: preview,
                                        preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Download", style: .default) { [weak self] _ in
            self?.dispatch(url: url)
        })
        sheet.addAction(UIAlertAction(title: "Copy Link", style: .default) { [weak self] _ in
            UIPasteboard.general.url = url
            self?.done()
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            self?.done()
        })
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        present(sheet, animated: true)
    }

    private func showNoLinkAlert() {
        let alert = UIAlertController(
            title: "FC Downloader",
            message: "No link found in the shared content.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
            self?.done()
        })
        present(alert, animated: true)
    }

    private func dispatch(url: URL) {
        UserDefaults(suiteName: appGroupId)?.set(url.absoluteString, forKey: "pendingShareUrl")
        var components = URLComponents()
        components.scheme = appScheme
        components.host = "share"
        components.queryItems = [URLQueryItem(name: "url", value: url.absoluteString)]
        guard let deepLink = components.url else { return done() }
        extensionContext?.open(deepLink) { [weak self] _ in self?.done() }
    }

    private func done() { extensionContext?.completeRequest(returningItems: nil) }
}
`;

const EXT_INFO_PLIST = `\
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>FC Downloader</string>
    <key>CFBundleExecutable</key>
    <string>$(EXECUTABLE_NAME)</string>
    <key>CFBundleIdentifier</key>
    <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <key>CFBundleName</key>
    <string>FC Downloader</string>
    <key>CFBundlePackageType</key>
    <string>XPC!</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${BUILD_NUMBER}</string>
    <key>NSExtension</key>
    <dict>
        <key>NSExtensionAttributes</key>
        <dict>
            <key>NSExtensionActivationRule</key>
            <dict>
                <key>NSExtensionActivationSupportsWebURLWithMaxCount</key>
                <integer>1</integer>
                <key>NSExtensionActivationSupportsWebPageWithMaxCount</key>
                <integer>1</integer>
                <key>NSExtensionActivationSupportsText</key>
                <true/>
            </dict>
        </dict>
        <key>NSExtensionPointIdentifier</key>
        <string>com.apple.share-services</string>
        <key>NSExtensionPrincipalClass</key>
        <string>$(PRODUCT_MODULE_NAME).ShareViewController</string>
    </dict>
</dict>
</plist>
`;

const EXT_ENTITLEMENTS = `\
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.application-groups</key>
    <array>
        <string>${APP_GROUP}</string>
    </array>
</dict>
</plist>
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeExtensionFiles(projectRoot) {
  const extDir = path.join(projectRoot, 'ios', EXT_NAME);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'ShareViewController.swift'), SHARE_VIEW_CONTROLLER);
  fs.writeFileSync(path.join(extDir, 'Info.plist'),                EXT_INFO_PLIST);
  fs.writeFileSync(path.join(extDir, `${EXT_NAME}.entitlements`),  EXT_ENTITLEMENTS);
}

function addExtensionToXcodeProject(project) {
  if (project.pbxTargetByName(EXT_NAME)) return; // already added

  const targetResult = project.addTarget(EXT_NAME, 'app_extension', EXT_NAME, EXT_BUNDLE_ID);
  const targetUuid   = targetResult.uuid;

  const groupResult  = project.addPbxGroup(
    ['ShareViewController.swift', 'Info.plist', `${EXT_NAME}.entitlements`],
    EXT_NAME, EXT_NAME,
  );
  const mainGroupUuid = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(groupResult.uuid, mainGroupUuid);

  project.addBuildPhase(['ShareViewController.swift'], 'PBXSourcesBuildPhase', 'Sources', targetUuid);

  // Build settings
  const allConfigs = project.pbxXCBuildConfigurationSection();
  const targetConfigUuids = (() => {
    const cl = project.pbxXCConfigurationList();
    const listUuid = targetResult.pbxNativeTarget.buildConfigurationList;
    return (cl[listUuid]?.buildConfigurations ?? []).map((b) => b.value);
  })();

  for (const key of targetConfigUuids) {
    const cfg = allConfigs[key];
    if (!cfg || !cfg.buildSettings) continue;
    const s = cfg.buildSettings;
    s.SWIFT_VERSION              = '5.0';
    s.INFOPLIST_FILE             = `${EXT_NAME}/Info.plist`;
    s.CODE_SIGN_ENTITLEMENTS     = `${EXT_NAME}/${EXT_NAME}.entitlements`;
    s.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
    s.SKIP_INSTALL               = 'YES';
    s.TARGETED_DEVICE_FAMILY     = '"1,2"';
    s.PRODUCT_BUNDLE_IDENTIFIER  = EXT_BUNDLE_ID;
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withShareExtensionPlugin(config) {
  // iOS only — skip entirely on Android
  if (!config.ios) return config;

  config = withEntitlementsPlist(config, (c) => {
    const groups = stringArray(c.modResults['com.apple.security.application-groups']);
    if (!groups.includes(APP_GROUP)) {
      c.modResults['com.apple.security.application-groups'] = [...groups, APP_GROUP];
    }
    return c;
  });

  config = withXcodeProject(config, (c) => {
    writeExtensionFiles(c.modRequest.projectRoot);
    try {
      addExtensionToXcodeProject(c.modResults);
    } catch (e) {
      console.warn(
        '[withShareExtension] Auto-add failed — open Xcode → File → New Target → ' +
        'Share Extension, name it "ShareExtension", replace generated files with ' +
        'those in ios/ShareExtension/. Error: ' + e.message,
      );
    }
    return c;
  });

  return config;
}

module.exports = createRunOncePlugin(withShareExtensionPlugin, 'withShareExtension', '1.0.0');
