/**
 * Expo Config Plugin — iOS Share Extension
 * iOS only — returns config unchanged on Android.
 */
// @ts-check
const { withAppDelegate, withXcodeProject, withEntitlementsPlist, createRunOncePlugin } = require('@expo/config-plugins');
const fs   = require('fs');
const path = require('path');

const EXT_NAME      = 'ShareExtension';
const BUNDLE_ID     = 'com.otterpia.fcdownloader';
const EXT_BUNDLE_ID = `${BUNDLE_ID}.ShareExtension`;
const APP_GROUP     = `group.${BUNDLE_ID}`;
const APP_SCHEME    = 'fcdownloader';
const DEPLOYMENT_TARGET = '15.1';
const SHARE_INTENT_SUBDIR = 'ShareIntent';
const SHARE_INTENT_SWIFT_FILE = 'ShareIntentModule.swift';
const SHARE_INTENT_OBJC_FILE = 'ShareIntentModule.m';

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function extensionVersion(config) {
  const version = typeof config.version === 'string' && config.version.trim()
    ? config.version.trim()
    : '1.0.0';
  const buildNumber = typeof config.ios?.buildNumber === 'string' && config.ios.buildNumber.trim()
    ? config.ios.buildNumber.trim()
    : '1';
  return { version, buildNumber };
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
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil else {
            return nil
        }
        return url
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
                if      let obj = obj as? URL      { url = self.firstURL(from: obj.absoluteString) }
                else if let obj = obj as? NSURL    { url = self.firstURL(from: (obj as URL).absoluteString) }
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
        if let defaults = UserDefaults(suiteName: appGroupId) {
            defaults.set(url.absoluteString, forKey: "pendingShareUrl")
            defaults.synchronize()
        }
        var components = URLComponents()
        components.scheme = appScheme
        components.host = "share"
        components.queryItems = [URLQueryItem(name: "url", value: url.absoluteString)]
        guard let deepLink = components.url else { return done() }
        extensionContext?.open(deepLink) { [weak self] opened in
            DispatchQueue.main.async {
                guard let self else { return }
                if !opened {
                    let openedViaResponder = self.openViaResponderChain(deepLink)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                        if openedViaResponder { self.done() }
                        else { self.showQueuedAlert() }
                    }
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    self.done()
                }
            }
        }
    }

    @discardableResult
    private func openViaResponderChain(_ url: URL) -> Bool {
        let modernSelector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.responds(to: modernSelector), let method = current.method(for: modernSelector) {
                typealias OpenUrlHandler = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
                let function = unsafeBitCast(method, to: OpenUrlHandler.self)
                function(current, modernSelector, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = current.next
        }

        let legacySelector = NSSelectorFromString("openURL:")
        responder = self
        while let current = responder {
            if current.responds(to: legacySelector) {
                current.perform(legacySelector, with: url)
                return true
            }
            responder = current.next
        }
        return false
    }

    private func showQueuedAlert() {
        let alert = UIAlertController(
            title: "Download queued",
            message: "Open FC Downloader to start the download.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
            self?.done()
        })
        present(alert, animated: true)
    }

    private func done() { extensionContext?.completeRequest(returningItems: nil) }
}
`;

function extensionInfoPlist(version, buildNumber) {
  return `\
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
    <string>${version}</string>
    <key>CFBundleVersion</key>
    <string>${buildNumber}</string>
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
}

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

const SHARE_INTENT_SWIFT_SOURCE = `\
import Foundation
import React

@objc(ShareIntentModule)
class ShareIntentModule: NSObject {

  private let appGroupId = "${APP_GROUP}"
  private let pendingShareKey = "pendingShareUrl"

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  @objc(getPendingShareUrl:rejecter:)
  func getPendingShareUrl(
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else {
      resolve(nil)
      return
    }

    let pending = defaults.string(forKey: pendingShareKey)
    if pending != nil {
      defaults.removeObject(forKey: pendingShareKey)
      defaults.synchronize()
    }
    resolve(pending)
  }
}
`;

const SHARE_INTENT_OBJC_BRIDGE = `\
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ShareIntentModule, NSObject)
RCT_EXTERN_METHOD(getPendingShareUrl:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeExtensionFiles(projectRoot, version, buildNumber) {
  const extDir = path.join(projectRoot, 'ios', EXT_NAME);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'ShareViewController.swift'), SHARE_VIEW_CONTROLLER);
  fs.writeFileSync(path.join(extDir, 'Info.plist'),                extensionInfoPlist(version, buildNumber));
  fs.writeFileSync(path.join(extDir, `${EXT_NAME}.entitlements`),  EXT_ENTITLEMENTS);
}

function writeShareIntentFiles(projectRoot) {
  const dir = path.join(projectRoot, 'ios', SHARE_INTENT_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SHARE_INTENT_SWIFT_FILE), SHARE_INTENT_SWIFT_SOURCE);
  fs.writeFileSync(path.join(dir, SHARE_INTENT_OBJC_FILE),  SHARE_INTENT_OBJC_BRIDGE);
}

function addExtensionToXcodeProject(project) {
  let targetResult = project.pbxTargetByName(EXT_NAME);

  if (!targetResult) {
    targetResult = project.addTarget(EXT_NAME, 'app_extension', EXT_NAME, EXT_BUNDLE_ID);
    const targetUuid = targetResult.uuid;

    const groupResult = project.addPbxGroup(
      ['ShareViewController.swift', 'Info.plist', `${EXT_NAME}.entitlements`],
      EXT_NAME, EXT_NAME,
    );
    const mainGroupUuid = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(groupResult.uuid, mainGroupUuid);

    project.addBuildPhase(['ShareViewController.swift'], 'PBXSourcesBuildPhase', 'Sources', targetUuid);
  }

  const targetUuid = targetResult.uuid;
  ensureExtensionTargetDependency(project, targetUuid);

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
    s.CODE_SIGN_STYLE            = 'Automatic';
    s.DEVELOPMENT_TEAM           = 'D8H3TBWH7P';
  }
}

function ensureExtensionTargetDependency(project, extensionTargetUuid) {
  const appTarget = project.pbxTargetByName('FCDownloader') || project.getFirstTarget();
  if (!appTarget?.uuid || appTarget.uuid === extensionTargetUuid) return;

  project.hash.project.objects.PBXContainerItemProxy ??= {};
  project.hash.project.objects.PBXTargetDependency ??= {};

  const nativeTargets = project.pbxNativeTargetSection();
  const appDependencies = nativeTargets[appTarget.uuid]?.dependencies ?? [];
  const targetDependencies = project.hash.project.objects.PBXTargetDependency;

  const alreadyLinked = appDependencies.some((dependency) => {
    const targetDependency = targetDependencies[dependency.value];
    return targetDependency?.target === extensionTargetUuid;
  });
  if (!alreadyLinked) {
    project.addTargetDependency(appTarget.uuid, [extensionTargetUuid]);
  }
}

function ensureExtensionSchemeEntry(projectRoot, extensionTargetUuid) {
  const schemePath = path.join(
    projectRoot,
    'ios',
    'FCDownloader.xcodeproj',
    'xcshareddata',
    'xcschemes',
    'FCDownloader.xcscheme',
  );
  if (!fs.existsSync(schemePath)) return;

  const scheme = fs.readFileSync(schemePath, 'utf8');
  if (scheme.includes('BlueprintName = "ShareExtension"')) return;

  const entry = `\
         <BuildActionEntry
            buildForTesting = "NO"
            buildForRunning = "NO"
            buildForProfiling = "NO"
            buildForArchiving = "YES"
            buildForAnalyzing = "NO">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${extensionTargetUuid}"
               BuildableName = "ShareExtension.appex"
               BlueprintName = "ShareExtension"
               ReferencedContainer = "container:FCDownloader.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
`;

  fs.writeFileSync(
    schemePath,
    scheme.replace('      </BuildActionEntries>', `${entry}      </BuildActionEntries>`),
  );
}

function addShareIntentModuleToXcodeProject(project, appTargetName) {
  const allFiles = project.pbxFileReferenceSection();
  for (const key of Object.keys(allFiles)) {
    const entry = allFiles[key];
    if (typeof entry === 'object' && entry.path && entry.path.includes(SHARE_INTENT_SWIFT_FILE)) {
      return;
    }
  }

  const groupResult = project.addPbxGroup(
    [SHARE_INTENT_SWIFT_FILE, SHARE_INTENT_OBJC_FILE],
    SHARE_INTENT_SUBDIR,
    SHARE_INTENT_SUBDIR,
  );
  const mainGroupUuid = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(groupResult.uuid, mainGroupUuid);

  const target = project.pbxTargetByName(appTargetName);
  if (!target) {
    throw new Error(`[withShareExtension] could not find app target "${appTargetName}"`);
  }
  project.addSourceFile(SHARE_INTENT_SWIFT_FILE, { target: target.uuid }, groupResult.uuid);
  project.addSourceFile(SHARE_INTENT_OBJC_FILE,  { target: target.uuid }, groupResult.uuid);
}

function patchAppDelegateForPendingShareFallback(contents) {
  if (contents.includes('pendingShareKey = "pendingShareUrl"')) {
    return contents;
  }

  let next = contents.replace(
    '  var reactNativeFactory: RCTReactNativeFactory?\n',
    `  var reactNativeFactory: RCTReactNativeFactory?\n\n  private let appGroupId = "${APP_GROUP}"\n  private let pendingShareKey = "pendingShareUrl"\n`,
  );

  next = next.replace(
    '#endif\n\n    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
    `#endif\n\n    if let launchUrl = launchOptions?[.url] as? URL {\n      storePendingShareUrl(from: launchUrl)\n    }\n\n    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`,
  );

  next = next.replace(
    '  ) -> Bool {\n    let result = RCTLinkingManager.application(app, open: url, options: options)',
    `  ) -> Bool {\n    storePendingShareUrl(from: url)\n    let result = RCTLinkingManager.application(app, open: url, options: options)`,
  );

  next = next.replace(
    '  ) -> Bool {\n    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)',
    `  ) -> Bool {\n    if let url = userActivity.webpageURL {\n      storePendingShareUrl(from: url)\n    }\n    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)`,
  );

  const helpers = `

  private func storePendingShareUrl(from incomingUrl: URL) {
    guard let sharedUrl = extractSharedUrl(from: incomingUrl),
          let defaults = UserDefaults(suiteName: appGroupId) else {
      return
    }
    defaults.set(sharedUrl.absoluteString, forKey: pendingShareKey)
    defaults.synchronize()
  }

  private func extractSharedUrl(from incomingUrl: URL) -> URL? {
    let scheme = incomingUrl.scheme?.lowercased()
    if scheme == "http" || scheme == "https" {
      return incomingUrl
    }

    guard scheme == "${APP_SCHEME}" || scheme == "${BUNDLE_ID}",
          incomingUrl.host == "share",
          let components = URLComponents(url: incomingUrl, resolvingAgainstBaseURL: false) else {
      return nil
    }

    for name in ["url", "text", "link"] {
      guard let value = components.queryItems?.first(where: { $0.name == name })?.value else {
        continue
      }
      if let sharedUrl = firstHttpUrl(in: value) {
        return sharedUrl
      }
    }
    return nil
  }

  private func firstHttpUrl(in value: String) -> URL? {
    let pattern = #"https?://[^\\s<>"'\\\\]+"#
    guard let range = value.range(of: pattern, options: .regularExpression) else {
      guard let url = URL(string: value),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https" else {
        return nil
      }
      return url
    }
    let candidate = String(value[range])
      .trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?)\\\\]}>'\\""))
    guard let url = URL(string: candidate),
          let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https" else {
      return nil
    }
    return url
  }
`;

  return next.replace('\n}\n\nclass ReactNativeDelegate:', `${helpers}\n}\n\nclass ReactNativeDelegate:`);
}

// ── Plugin ────────────────────────────────────────────────────────────────────

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withShareExtensionPlugin(config) {
  // iOS only — skip entirely on Android
  if (!config.ios) return config;

  const { version, buildNumber } = extensionVersion(config);

  config = withEntitlementsPlist(config, (c) => {
    const groups = stringArray(c.modResults['com.apple.security.application-groups']);
    if (!groups.includes(APP_GROUP)) {
      c.modResults['com.apple.security.application-groups'] = [...groups, APP_GROUP];
    }
    return c;
  });

  config = withXcodeProject(config, (c) => {
    const appTarget = c.modRequest.projectName || 'FCDownloader';
    writeExtensionFiles(c.modRequest.projectRoot, version, buildNumber);
    writeShareIntentFiles(c.modRequest.projectRoot);
    try {
      addExtensionToXcodeProject(c.modResults);
      addShareIntentModuleToXcodeProject(c.modResults, appTarget);
      const extensionTarget = c.modResults.pbxTargetByName(EXT_NAME);
      if (extensionTarget?.uuid) {
        ensureExtensionSchemeEntry(c.modRequest.projectRoot, extensionTarget.uuid);
      }
    } catch (e) {
      console.warn(
        '[withShareExtension] Auto-add failed — open Xcode → File → New Target → ' +
        'Share Extension, name it "ShareExtension", replace generated files with ' +
        'those in ios/ShareExtension/. Error: ' + e.message,
      );
    }
    return c;
  });

  config = withAppDelegate(config, (c) => {
    if (c.modResults.language === 'swift') {
      c.modResults.contents = patchAppDelegateForPendingShareFallback(c.modResults.contents);
    }
    return c;
  });

  return config;
}

module.exports = createRunOncePlugin(withShareExtensionPlugin, 'withShareExtension', '1.0.0');
