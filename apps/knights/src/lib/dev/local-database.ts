import { parse } from 'pg-connection-string';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Reads the host the way `pg` will connect to it, so a `?host=` override cannot point a local-looking URL elsewhere. */
export function assertLocalDatabase(connectionString: string | undefined): void {
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  let host: string | null | undefined;
  try {
    if (!/^postgres(ql)?:\/\//.test(connectionString)) throw new Error('not a URL');
    host = parse(connectionString).host;
  } catch {
    throw new Error('DATABASE_URL is not a valid connection string.');
  }
  if (!host || !LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run: the database host is "${
        host ?? ''
      }". This script only runs against localhost, 127.0.0.1 or ::1.`
    );
  }
}
