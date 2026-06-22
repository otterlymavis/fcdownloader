# Expo HAS CHANGED

## Command Output

Protect context usage. **Any command with unknown or potentially large output must be byte-capped.**

Default pattern:

```bash
COMMAND 2>&1 | head -c 4000
```

## Platform Isolation

Treat every product target as isolated unless the user explicitly requests a
cross-platform change.

Before editing:

1. Identify and state the requested target(s).
2. Record the existing working-tree state with:

   ```bash
   git status --short 2>&1 | head -c 4000
   ```

3. Do not modify files outside the requested target's boundary.
4. Existing changes belong to the user. Never revert, overwrite, format, or
   include them merely because they are present.

### Target boundaries

#### Shared Expo application code

These paths can affect the iOS app, Android app, and Expo web app:

- `App.tsx`
- `src/` except platform-suffixed files
- `assets/`
- `app.config.ts`
- `index.ts`
- `metro.config.js`
- shared dependencies and configuration in `package.json`

Do not use shared files for a one-platform UI change unless the implementation
is explicitly isolated. Prefer:

- `*.ios.ts` / `*.ios.tsx` for iOS
- `*.android.ts` / `*.android.tsx` for Android
- `*.web.ts` / `*.web.tsx` for Expo web
- a narrowly scoped `Platform.OS` branch when separate files are impractical

When editing a shared file, preserve behavior on every non-requested platform
and verify the change is platform-gated.

#### iOS main app only

- `ios/FCDownloader/`
- iOS app configuration under `ios/`, excluding extension directories
- `*.ios.ts` / `*.ios.tsx`

Do not modify these extension paths during an iOS main-app-only task:

- `ios/ShareExtension/`
- `ios/ShareIntent/`
- `plugins/withShareExtension.ts`
- `plugins/withShareExtension.js`
- `safari-extension/`
- `safari-extension-xcode/`
- `extension/`

#### Android main app only

- `android/`
- `*.android.ts` / `*.android.tsx`

Do not modify iOS, browser-extension, Safari-extension, web-site, desktop, or
server paths during an Android-only task.

#### Expo web app only

- `*.web.ts` / `*.web.tsx`
- web-gated branches in shared Expo components

The root `web/` directory is a separate static website. Do not modify it for an
Expo web task unless the user explicitly includes the static website.

#### Static website only

- `web/`

Do not modify the Expo app, native apps, extensions, desktop companion, or
server for a static-website-only task.

#### Browser extension only

- `extension/`

Do not copy changes into `safari-extension/` or
`safari-extension-xcode/` unless the user explicitly requests the Safari
extension too.

#### Safari extension source only

- `safari-extension/`

Do not modify the containing Safari Xcode app or its copied extension resources
unless packaging/syncing is explicitly requested.

#### Safari extension Xcode project only

- `safari-extension-xcode/`

Keep containing-app UI under `Shared (App)` separate from extension UI and
logic under `Shared (Extension)`.

#### iOS Share Extension only

- `ios/ShareExtension/`
- `ios/ShareIntent/`
- `plugins/withShareExtension.ts`
- `plugins/withShareExtension.js`

Do not modify the main iOS application UI for a Share Extension task.

#### Desktop companion only

- `desktop-companion/`

Do not modify browser extensions, mobile apps, web apps, or server unless the
user explicitly requests an integration change.

#### Server only

- `server/`

Client changes are outside a server-only task. If an API contract must change,
report the client impact and request or confirm cross-target scope before
editing clients.

### Generated native projects

Commands such as `npx expo prebuild`, `expo run:ios`, and `expo run:android`
may regenerate or alter native projects. Do not run a clean prebuild or
regenerate both platforms for a single-platform task.

If native regeneration is required:

- use the requested platform flag;
- inspect changed files immediately afterward;
- keep only changes belonging to the requested target;
- never delete or replace unrelated user changes.

### Cross-platform and shared-contract changes

A shared change is allowed only when:

- the user requested all affected targets, or
- it is necessary for the requested target and all other targets are explicitly
  protected through platform-specific code and verification.

Shared API types, download logic, translations, dependencies, and build
configuration are not automatically safe merely because they are not UI files.
State their expected target impact before changing them.

### Final scope check

Before finishing, run:

```bash
git diff --name-only 2>&1 | head -c 4000
```

Compare the result with the initial working-tree state and the declared target.
If this task introduced a change outside the target boundary:

1. stop;
2. do not silently revert files that may contain user work;
3. isolate only the edits introduced by this task when safe;
4. otherwise report the out-of-scope file and ask for direction.

In the final response, name the target changed and explicitly confirm which
other targets were left untouched.



# Branch naming
Use conventional branch names: feat/<description>, fix/<description>, chore/<description>.
Do NOT prefix branches with "codex/".
