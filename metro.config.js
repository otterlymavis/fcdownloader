const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const exclusionList = require(path.join(
  path.dirname(require.resolve('metro-config/package.json')),
  'src/defaults/exclusionList.js',
)).default;

const config = getDefaultConfig(__dirname);

function blockPath(...parts) {
  const escaped = path
    .resolve(__dirname, ...parts)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?:[/\\\\].*)?$`);
}

config.resolver.blockList = exclusionList([
  blockPath('artifacts'),
  blockPath('dist'),
  blockPath('desktop-companion', 'dist'),
  blockPath('desktop-companion', 'build'),
  blockPath('desktop-companion', 'node_modules'),
  blockPath('history_logs'),
  blockPath('pytest-of-mabis'),
  blockPath('.pytest_cache'),
  blockPath('server', '.pytest_cache'),
]);

module.exports = config;
