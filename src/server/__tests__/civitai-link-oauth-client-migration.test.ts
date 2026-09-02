import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The `civitai-link-desktop` client row is registered by a MANUAL-APPLY SQL migration, so the
 * bitmask in it is a hand-typed literal that nothing else checks. If it drifts from the enum, the
 * hub answers `invalid_scope` to every desktop sign-in and there is no failing test anywhere —
 * the symptom is a support ticket. This is that check.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIGRATIONS = path.join(REPO_ROOT, 'packages/civitai-db-schema/prisma/migrations');
const SUFFIX = '_register_civitai_link_desktop_oauth_client';

const LINK_DESKTOP_SCOPE =
  TokenScope.UserRead | TokenScope.VaultRead | TokenScope.VaultWrite | TokenScope.LinkConnect;

function migrationSql(): string {
  const dirs = fs.readdirSync(MIGRATIONS).filter((d) => d.endsWith(SUFFIX));
  // Positive control: two copies would make "the literal is present" true of the wrong file.
  expect(
    dirs,
    `expected exactly one *${SUFFIX} migration, found ${dirs.join(', ') || 'none'}`
  ).toHaveLength(1);
  return fs.readFileSync(path.join(MIGRATIONS, dirs[0], 'migration.sql'), 'utf8');
}

describe('civitai-link-desktop OAuth client migration', () => {
  it('grants exactly UserRead|VaultRead|VaultWrite|LinkConnect', () => {
    expect(LINK_DESKTOP_SCOPE).toBe(159383553);
    expect(migrationSql()).toContain('159383553');
  });

  it('registers the id the desktop app hardcodes, idempotently', () => {
    const sql = migrationSql();
    expect(sql).toContain("'civitai-link-desktop'");
    expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('is a PUBLIC device-grant client — no secret, no authorization_code', () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "ARRAY['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']::TEXT[]"
    );
    // The app has no deep-link handler, so it cannot complete an authorization_code redirect.
    expect(sql).not.toContain("'authorization_code'");
  });

  it('carries the manual-apply banner (these migrations are never auto-run)', () => {
    expect(migrationSql()).toContain('MANUAL-APPLY');
  });
});
