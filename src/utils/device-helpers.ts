export const isTouchDevice = () =>
  typeof document !== 'undefined' && 'ontouchstart' in document.documentElement;

export const isAndroidDevice = () => {
  if (typeof document === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.indexOf('android') > -1; //&& ua.indexOf("mobile");
};
