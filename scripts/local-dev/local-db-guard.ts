// The notification DB published by docker-compose.base.yml, and the devcontainer's service name.
export const LOCAL_NOTIFICATION_DB_HOSTS = [
  'localhost:15434',
  '127.0.0.1:15434',
  'notification-db:5432',
];

/** True only when the URL's own host:port is one of `hosts`, not when it merely contains one. */
export function isLocalDbUrl(url: string | undefined, hosts: string[]) {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return hosts.includes(`${parsed.hostname}:${parsed.port || '5432'}`);
}
