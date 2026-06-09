// A very hacky mock to let tsx compile react-native files
require('module-alias').addAlias('react-native', __dirname + '/mock-rn.js');
require('module-alias').addAlias('expo-constants', __dirname + '/mock-expo.js');
