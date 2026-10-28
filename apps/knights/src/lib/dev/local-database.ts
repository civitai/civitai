const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function assertLocalDatabase(connectionString: string | undefined): void {
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid connection string.');
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run: the database host is "${host}". This script only runs against localhost or 127.0.0.1.`
    );
  }
}
