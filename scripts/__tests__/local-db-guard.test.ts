import { describe, expect, it } from 'vitest';
import {
  LOCAL_MAIN_DB_HOSTS,
  LOCAL_NOTIFICATION_DB_HOSTS,
  describeDbUrl,
  isLocalDbUrl,
} from '../local-dev/local-db-guard';

// gen_seed TRUNCATEs tables on DATABASE_URL and NOTIFICATION_DB_URL, so these guards are all that
// stand between a mis-set env and a wiped database.
describe('isLocalDbUrl', () => {
  const notif = (url?: string) => isLocalDbUrl(url, LOCAL_NOTIFICATION_DB_HOSTS);
  const main = (url?: string) => isLocalDbUrl(url, LOCAL_MAIN_DB_HOSTS);

  it('accepts the local databases', () => {
    expect(notif('postgresql://postgres:postgres@localhost:15434/postgres')).toBe(true);
    expect(notif('postgresql://postgres:postgres@127.0.0.1:15434/postgres')).toBe(true);
    expect(notif('postgresql://postgres:postgres@notification-db/postgres')).toBe(true);
    expect(main('postgresql://postgres:postgres@localhost:15432/civitai?sslmode=disable')).toBe(
      true
    );
    expect(main('postgresql://postgres:postgres@db:5432/civitai')).toBe(true);
  });

  it('refuses an unset or unparsable URL', () => {
    expect(notif(undefined)).toBe(false);
    expect(notif('')).toBe(false);
    expect(notif('not a url')).toBe(false);
  });

  it('refuses a remote host, and a local port on a remote host', () => {
    expect(notif('postgresql://u:p@db.example.com:5432/notifications')).toBe(false);
    expect(notif('postgresql://u:p@db.example.com:15434/notifications')).toBe(false);
    expect(notif('postgresql://u:p@localhost:15432/civitai')).toBe(false);
    expect(main('postgresql://u:p@civitai-prod-db:5432/civitai')).toBe(false);
    expect(main('postgresql://u:p@localhost.example.com:15432/civitai')).toBe(false);
  });

  it('judges the host, not a local address appearing elsewhere in the URL', () => {
    expect(notif('postgresql://u:localhost:15434@db.example.com:5432/x')).toBe(false);
    expect(notif('postgresql://u:p@db.example.com:5432/x?application_name=localhost:15434')).toBe(
      false
    );
    expect(main('postgresql://u:localhost:15432@prod.example.com:5432/civitai')).toBe(false);
  });

  // pg's connection-string parser lets these replace the URL's own host and port.
  it('refuses a local URL whose query string points the connection elsewhere', () => {
    expect(notif('postgresql://u:p@localhost:15434/x?host=db.example.com&port=5432')).toBe(false);
    expect(notif('postgresql://u:p@localhost:15434/x?hostaddr=10.0.0.1')).toBe(false);
    expect(main('postgresql://u:p@localhost:15432/civitai?host=db.example.com')).toBe(false);
  });
});

describe('describeDbUrl', () => {
  it('logs host:port without credentials', () => {
    const described = describeDbUrl('postgresql://user:s3cret@localhost:15432/civitai');
    expect(described).toBe('localhost:15432');
    expect(described).not.toContain('s3cret');
  });
});
