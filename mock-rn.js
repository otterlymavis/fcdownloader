module.exports = {
  Platform: { OS: 'android', select: (obj) => obj.android || obj.default },
};
