/**
 * Expo Config Plugin — iOS Share Extension
 *
 * Adds a Share Extension target so FC Downloader appears in Safari's
 * share sheet. The user taps Share → FC Downloader, then chooses:
 *   • Download  — opens the app via fcdownloader://share?url=... and starts download
 *   • Copy Link — copies the URL to the clipboard (paste into any app)
 *
 * Usage: add './plugins/withShareExtension' to plugins[] in app.config.ts
 * Then run: npx expo prebuild --platform ios
 */

import {
  ConfigPlugin,
  withXcodeProject,
  withEntitlementsPlist,
  createRunOncePlugin,
} from '@expo/config-plugins';
import * as fs   from 'fs';
import * as path from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const EXT_NAME       = 'ShareExtension';
const BUNDLE_ID      = 'com.mabisuuu.fcdownloader';
const EXT_BUNDLE_ID  = `${BUNDLE_ID}.ShareExtension`;
const APP_GROUP      = `group.${BUNDLE_ID}`;
const APP_SCHEME     = 'fcdownloader';
const DEPLOYMENT_TARGET = '14.0';

// ── Swift source ──────────────────────────────────────────────────────────────

const SHARE_VIEW_CONTROLLER = `\
import UIKit
import UniformTypeIdentifiers
import MobileCoreServices

class ShareViewController: UIViewController {

    private let appGroupId = "${APP_GROUP}"
    private let appScheme  = "${APP_SCHEME}"

    override func viewDidLoad() {
        super.viewDidLoad()
        // Transparent background so iOS shows the sheet on top of Safari
        view.backgroundColor = UIColor.black.withAlphaComponent(0)
        extractURL { [weak self] url in
            DispatchQueue.main.async {
                guard let self else { return }
                if let url = url { self.showSheet(for: url) }
                else             { self.done() }
            }
        }
    }

    // ── URL extraction ────────────────────────────────────────────

    private func extractURL(completion: @escaping (URL?) -> Void) {
        guard let item = extensionContext?.inputItems.first as? NSExtensionItem else {
            return completion(nil)
        }

        // Try URL type first, then plain text (some pages share as text)
        let typeIds: [String]
        if #available(iOS 14.0, *) {
            typeIds = [UTType.url.identifier, UTType.plainText.identifier]
        } else {
            typeIds = [kUTTypeURL as String, kUTTypePlainText as String]
        }

        for attachment in item.attachments ?? [] {
            for typeId in typeIds {
                guard attachment.hasItemConformingToTypeIdentifier(typeId) else { continue }
                attachment.loadItem(forTypeIdentifier: typeId) { obj, _ in
                    if      let url  = obj as? URL    { completion(url) }
                    else if let text = obj as? String,
                            let url  = URL(string: text) { completion(url) }
                    else    { completion(nil) }
                }
                return
            }
        }
        completion(nil)
    }

    // ── Action sheet ──────────────────────────────────────────────

    private func showSheet(for url: URL) {
        let urlStr = url.absoluteString
        let preview = urlStr.count > 80 ? String(urlStr.prefix(80)) + "\\u2026" : urlStr

        let sheet = UIAlertController(
            title:   "FC Downloader",
            message: preview,
            preferredStyle: .actionSheet
        )
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

        // iPad needs a source view for the popover
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }

        present(sheet, animated: true)
    }

    // ── Dispatch to main app ──────────────────────────────────────

    private func dispatch(url: URL) {
        // Persist URL in shared App Group storage as a fallback if deep link
        // fires before the app finishes launching.
        if let defaults = UserDefaults(suiteName: appGroupId) {
            defaults.set(url.absoluteString, forKey: "pendingShareUrl")
            defaults.synchronize()
        }

        let encoded = url.absoluteString
            .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        guard let deepLink = URL(string: "\\(appScheme)://share?url=\\(encoded)") else {
            return done()
        }

        // extensionContext?.open is the only supported way to open the host app
        // from a Share Extension (UIApplication.shared is unavailable here).
        extensionContext?.open(deepLink) { [weak self] _ in self?.done() }
    }

    private func done() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
`;

// ── Extension Info.plist ──────────────────────────────────────────────────────

const EXT_INFO_PLIST = `\
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
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

// ── Extension entitlements ────────────────────────────────────────────────────

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

// ── File helpers ──────────────────────────────────────────────────────────────

function writeExtensionFiles(projectRoot: string): void {
  const extDir = path.join(projectRoot, 'ios', EXT_NAME);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'ShareViewController.swift'), SHARE_VIEW_CONTROLLER);
  fs.writeFileSync(path.join(extDir, 'Info.plist'),                EXT_INFO_PLIST);
  fs.writeFileSync(path.join(extDir, `${EXT_NAME}.entitlements`),  EXT_ENTITLEMENTS);
}

// ── Xcode project manipulation ────────────────────────────────────────────────

function addExtensionToXcodeProject(
  project: ReturnType<typeof withXcodeProject> extends ConfigPlugin<infer _> ? never : any,
  bundleId: string,
): void {
  // Skip if already added
  if (project.pbxTargetByName(EXT_NAME)) return;

  // 1. Create the extension target
  const targetResult = project.addTarget(
    EXT_NAME,
    'app_extension',
    EXT_NAME,
    EXT_BUNDLE_ID,
  );
  const targetUuid = targetResult.uuid;

  // 2. Create a PBX group for the extension files
  const groupResult = project.addPbxGroup(
    ['ShareViewController.swift', 'Info.plist', `${EXT_NAME}.entitlements`],
    EXT_NAME,
    EXT_NAME,
  );

  // 3. Attach the group to the project's main group
  const mainGroupUuid: string =
    project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(groupResult.uuid, mainGroupUuid);

  // 4. Add build phases
  project.addBuildPhase(
    ['ShareViewController.swift'],
    'PBXSourcesBuildPhase',
    'Sources',
    targetUuid,
  );
  project.addBuildPhase(
    ['Info.plist'],
    'PBXResourcesBuildPhase',
    'Resources',
    targetUuid,
  );

  // 5. Set build settings on the extension target's configurations
  const configurations: Record<string, any> = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const config = configurations[key];
    if (
      typeof config === 'object' &&
      config.buildSettings !== undefined &&
      config.name !== undefined
    ) {
      // Only touch configurations owned by our new target
      const targetConfigs: string[] =
        targetResult.pbxNativeTarget.buildConfigurationList
          ? project
              .pbxXCConfigurationList()[
                targetResult.pbxNativeTarget.buildConfigurationList
              ]
              ?.buildConfigurations?.map((b: any) => b.value) ?? []
          : [];
      if (!targetConfigs.includes(key)) continue;

      const s = config.buildSettings;
      s.SWIFT_VERSION                = '5.0';
      s.INFOPLIST_FILE               = `${EXT_NAME}/Info.plist`;
      s.CODE_SIGN_ENTITLEMENTS       = `${EXT_NAME}/${EXT_NAME}.entitlements`;
      s.IPHONEOS_DEPLOYMENT_TARGET   = DEPLOYMENT_TARGET;
      s.SKIP_INSTALL                 = 'YES';
      s.TARGETED_DEVICE_FAMILY       = '"1,2"';
      s.PRODUCT_BUNDLE_IDENTIFIER    = `"${EXT_BUNDLE_ID}"`;
    }
  }
}

// ── Plugin definition ─────────────────────────────────────────────────────────

const withShareExtensionPlugin: ConfigPlugin = (config) => {
  // Add App Group entitlement to the main app so it can share UserDefaults
  // with the extension (used as fallback when deep link fires on cold start).
  config = withEntitlementsPlist(config, (c) => {
    const existing: string[] =
      c.modResults['com.apple.security.application-groups'] ?? [];
    if (!existing.includes(APP_GROUP)) {
      c.modResults['com.apple.security.application-groups'] = [
        ...existing,
        APP_GROUP,
      ];
    }
    return c;
  });

  config = withXcodeProject(config, (c) => {
    writeExtensionFiles(c.modRequest.projectRoot);
    try {
      addExtensionToXcodeProject(c.modResults, BUNDLE_ID);
    } catch (e) {
      console.warn(
        '[withShareExtension] Could not automatically add Xcode target. ' +
        'Open Xcode → File → New → Target → Share Extension, ' +
        'name it "ShareExtension", then replace the generated files with ' +
        'those in ios/ShareExtension/. Error: ' + (e as Error).message,
      );
    }
    return c;
  });

  return config;
};

export default createRunOncePlugin(
  withShareExtensionPlugin,
  'withShareExtension',
  '1.0.0',
);
