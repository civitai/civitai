export const reloadSession = () => {
  const event = new Event('visibilitychange');
  document.dispatchEvent(event);
};
