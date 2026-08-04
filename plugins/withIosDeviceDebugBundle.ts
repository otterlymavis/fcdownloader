import {
  ConfigPlugin,
  createRunOncePlugin,
  withXcodeProject,
} from '@expo/config-plugins';

const PLUGIN_NAME = 'withIosDeviceDebugBundle';
const PLUGIN_VERSION = '1.0.0';
const PHASE_NAME = 'Bundle React Native code and images';
const OLD_DEBUG_SKIP = 'if [[ "$CONFIGURATION" = *Debug* ]]; then\\n  export SKIP_BUNDLING=1\\nfi';
const DEVICE_AWARE_DEBUG_SKIP = 'if [[ "$CONFIGURATION" = *Debug* && "$PLATFORM_NAME" == *simulator ]]; then\\n  export SKIP_BUNDLING=1\\nfi';
const REACT_NATIVE_XCODE_SCRIPT =
  '`"$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'"`';
const PHYSICAL_DEVICE_RELEASE_CONFIG =
  'if [[ "$CONFIGURATION" = *Debug* && "$PLATFORM_NAME" != *simulator ]]; then\\n  export CONFIGURATION=Release\\nfi';
const PHYSICAL_DEVICE_PRODUCTION_BUNDLE =
  `${PHYSICAL_DEVICE_RELEASE_CONFIG}\\n\\n${REACT_NATIVE_XCODE_SCRIPT}`;

function patchBundleScript(shellScript: string): string {
  const next = shellScript.replace(OLD_DEBUG_SKIP, DEVICE_AWARE_DEBUG_SKIP);
  if (next.includes(PHYSICAL_DEVICE_RELEASE_CONFIG)) {
    return next;
  }
  if (!next.includes(REACT_NATIVE_XCODE_SCRIPT)) {
    throw new Error(`${PLUGIN_NAME}: could not find React Native bundle script invocation`);
  }
  return next.replace(REACT_NATIVE_XCODE_SCRIPT, PHYSICAL_DEVICE_PRODUCTION_BUNDLE);
}

const withIosDeviceDebugBundle: ConfigPlugin = (config) =>
  withXcodeProject(config, (projectConfig) => {
    const phases = projectConfig.modResults.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    let patched = false;

    for (const phase of Object.values(phases)) {
      if (!phase || typeof phase !== 'object') continue;
      const buildPhase = phase as { name?: string; shellScript?: string };
      if (buildPhase.name !== `"${PHASE_NAME}"` || typeof buildPhase.shellScript !== 'string') {
        continue;
      }
      buildPhase.shellScript = patchBundleScript(buildPhase.shellScript);
      patched = true;
    }

    if (!patched) {
      throw new Error(`${PLUGIN_NAME}: could not find "${PHASE_NAME}" build phase`);
    }

    return projectConfig;
  });

export default createRunOncePlugin(withIosDeviceDebugBundle, PLUGIN_NAME, PLUGIN_VERSION);
