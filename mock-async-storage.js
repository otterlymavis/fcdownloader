const store = new Map();

module.exports = {
  default: {
    async getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async setItem(key, value) {
      store.set(key, String(value));
    },
    async removeItem(key) {
      store.delete(key);
    },
  },
};
