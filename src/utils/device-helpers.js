export const isTouchDevice = () => typeof document !== 'undefined' && 'ontouchstart' in document.documentElement
