export function detectOS(userAgent: string) {
  if (userAgent?.includes('Win')) return 'Windows';
  if (userAgent?.includes('Mac')) return 'Mac';
  if (userAgent?.includes('Linux')) return 'Linux';
  return 'Unknown';
}

// Thrown together with ChatGPT :^) -Manuel
export function detectBrowser() {
  const userAgent = navigator.userAgent;
  let name = 'Unknown';
  let version: string | null = null;

  if (/Edg\/\d+/i.test(userAgent)) {
    name = 'Microsoft Edge';
    version = userAgent.match(/Edg\/(\d+)/)?.[1] || null;
  } else if (
    /Chrome\/\d+/i.test(userAgent) &&
    !/Edg\//i.test(userAgent) &&
    !/OPR\//i.test(userAgent)
  ) {
    name = 'Google Chrome';
    version = userAgent.match(/Chrome\/(\d+)/)?.[1] || null;
  } else if (/Safari\/\d+/i.test(userAgent) && !/Chrome\//i.test(userAgent)) {
    name = 'Safari';
    version = userAgent.match(/Version\/(\d+)/)?.[1] || null;
  } else if (/Firefox\/\d+/i.test(userAgent)) {
    name = 'Mozilla Firefox';
    version = userAgent.match(/Firefox\/(\d+)/)?.[1] || null;
  } else if (/OPR\/\d+/i.test(userAgent)) {
    name = 'Opera';
    version = userAgent.match(/OPR\/(\d+)/)?.[1] || null;
  } else if (/Trident\/\d+/i.test(userAgent)) {
    name = 'Internet Explorer';
    version = userAgent.match(/rv:(\d+)/)?.[1] || null;
  }

  return { name, version };
}
