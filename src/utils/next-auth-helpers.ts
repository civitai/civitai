export const reloadSession = async () => {
  await fetch('/api/auth/session?update');
  const event = new Event('visibilitychange');
  document.dispatchEvent(event);
};
