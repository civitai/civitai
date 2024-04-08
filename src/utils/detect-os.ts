export function detectOS(userAgent: string) {
  if (userAgent?.includes('Win')) return 'Windows';
  if (userAgent?.includes('Mac')) return 'Mac';
  if (userAgent?.includes('Linux')) return 'Linux';
  return 'Unknown';
}
