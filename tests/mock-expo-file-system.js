class File {
  constructor(uri) {
    this.uri = String(uri || '');
  }
}

module.exports = {
  File,
  Paths: { document: '/tmp/fcdl-test/' },
  documentDirectory: '/tmp/fcdl-test/',
  cacheDirectory: '/tmp/fcdl-test-cache/',
  EncodingType: { UTF8: 'utf8', Base64: 'base64' },
  async getInfoAsync() { return { exists: false, size: 0 }; },
  async makeDirectoryAsync() {},
  async deleteAsync() {},
  async writeAsStringAsync() {},
  async readAsStringAsync() { return ''; },
  async downloadAsync() { return { uri: '/tmp/fcdl-test/download' }; },
};
