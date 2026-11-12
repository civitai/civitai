// docker-compose.base.yml publishes these; `db` and `notification-db` are the devcontainer services.
export const LOCAL_MAIN_DB_HOSTS = ['localhost:15432', '127.0.0.1:15432', 'db:5432'];
export const LOCAL_NOTIFICATION_DB_HOSTS = [
  'localhost:15434',
  '127.0.0.1:15434',
  'notification-db:5432',
];

// pg (pg-connection-string) lets these query parameters replace the URL's own host and port.
const CONNECTION_TARGET_PARAMS = ['host', 'hostaddr', 'port'];

/** True only when the URL's own host:port is one of `hosts`, not when it merely contains one. */
export function isLocalDbUrl(url: string | undefined, hosts: string[]) {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (CONNECTION_TARGET_PARAMS.some((param) => parsed.searchParams.has(param))) return false;
  return hosts.includes(`${parsed.hostname}:${parsed.port || '5432'}`);
}

/** host:port only, for logging a connection string without its credentials. */
export function describeDbUrl(url: string | undefined) {
  try {
    const parsed = new URL(url ?? '');
    return `${parsed.hostname}:${parsed.port || '5432'}`;
  } catch {
    return '(unparsable URL)';
  }
}
