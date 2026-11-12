import { describe, expect, it } from 'vitest';
import { LOCAL_NOTIFICATION_DB_HOSTS, isLocalDbUrl } from '../local-dev/local-db-guard';

// gen_seed TRUNCATEs "Notification" on NOTIFICATION_DB_URL, so this guard is all that stands
// between a mis-set env and a wiped database.
describe('isLocalDbUrl (notification DB)', () => {
  const ok = (url?: string) => isLocalDbUrl(url, LOCAL_NOTIFICATION_DB_HOSTS);

  it('accepts the local notification databases', () => {
    expect(ok('postgresql://postgres:postgres@localhost:15434/postgres')).toBe(true);
    expect(ok('postgresql://postgres:postgres@127.0.0.1:15434/postgres')).toBe(true);
    expect(ok('postgresql://postgres:postgres@notification-db:5432/postgres')).toBe(true);
  });

  it('refuses an unset or unparsable URL', () => {
    expect(ok(undefined)).toBe(false);
    expect(ok('')).toBe(false);
    expect(ok('not a url')).toBe(false);
  });

  it('refuses a remote host, and a local port on a remote host', () => {
    expect(ok('postgresql://u:p@db.example.com:5432/notifications')).toBe(false);
    expect(ok('postgresql://u:p@db.example.com:15434/notifications')).toBe(false);
    expect(ok('postgresql://u:p@localhost:15432/civitai')).toBe(false);
  });

  it('judges the host, not a local address appearing elsewhere in the URL', () => {
    expect(ok('postgresql://u:localhost:15434@db.example.com:5432/x')).toBe(false);
    expect(ok('postgresql://u:p@db.example.com:5432/x?application_name=localhost:15434')).toBe(
      false
    );
  });
});
