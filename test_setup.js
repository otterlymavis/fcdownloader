// A very hacky mock to let tsx compile react-native files
require('module-alias').addAlias('react-native', __dirname + '/mock-rn.js');
require('module-alias').addAlias('expo-constants', __dirname + '/mock-expo.js');
require('module-alias').addAlias('@react-native-async-storage/async-storage', __dirname + '/mock-async-storage.js');
require('module-alias').addAlias('expo-file-system', __dirname + '/mock-expo-file-system.js');
require('module-alias').addAlias('expo-file-system/legacy', __dirname + '/mock-expo-file-system.js');
require('module-alias').addAlias('expo/fetch', __dirname + '/mock-expo-fetch.js');
global.__DEV__ = false;
globalThis.expo = globalThis.expo || {
  EventEmitter: class {},
  NativeModule: class {},
  SharedObject: class {},
  SharedRef: class {},
  modules: {},
};
