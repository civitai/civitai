import { parse } from 'pg-connection-string';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Checks the host `pg` actually connects to, not the URL authority. */
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
