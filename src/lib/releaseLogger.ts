export function debugLog(...args: unknown[]): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.log(...args);
}

export function debugWarn(...args: unknown[]): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn(...args);
}
