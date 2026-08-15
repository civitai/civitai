import { describe, expect, it } from 'vitest';

// Lives under scripts/ because the daemon is not part of the app's module graph — same arrangement
// as the queue's tests beside it.
const {
  parseModeDefinitions,
  loadModeDefinitions,
  resolveSessionModes,
  applyModes,
  formatModeSummary,
  sameResolvedModes,
} = await import('../../.claude/skills/dev-server/scripts/env-modes.mjs');

const defs = (text: string) => ({
  path: 'env-modes.local',
  exists: true,
  ...parseModeDefinitions(text),
});

const TWO_GROUPS = defs(
  [
    '[db.dev]',
    'DATABASE_URL=postgres://dev-host/civitai',
    'DATABASE_IS_PROD=false',
    '[db.prod]',
    'DATABASE_URL=postgres://prod-host/civitai',
    'DATABASE_IS_PROD=true',
    '[buzz.dev]',
    'BUZZ_ENDPOINT=http://localhost:28081',
    '[buzz.prod]',
    'BUZZ_ENDPOINT=http://localhost:28080',
  ].join('\n')
);

const modesOf = (result: { modes: Record<string, { mode: string }> }) =>
  Object.fromEntries(Object.entries(result.modes).map(([group, choice]) => [group, choice.mode]));

const resolve = (opts: Record<string, unknown> = {}) =>
  resolveSessionModes({ definitions: TWO_GROUPS, prod: [], dev: [], ...opts });

describe('env mode resolution', () => {
  it('puts every group on dev when nothing is asked for', () => {
    expect(modesOf(resolve())).toEqual({ db: 'dev', buzz: 'dev' });
  });

  it('moves only the groups named on --prod', () => {
    expect(modesOf(resolve({ prod: ['db'] }))).toEqual({ db: 'prod', buzz: 'dev' });
  });

  it('takes the skill default, and lets a flag beat it', () => {
    expect(modesOf(resolve({ defaultProdGroups: ['buzz'] })).buzz).toBe('prod');
    expect(modesOf(resolve({ dev: ['buzz'], defaultProdGroups: ['buzz'] })).buzz).toBe('dev');
  });

  it('reads --prod all --dev x as "all of it except x"', () => {
    expect(modesOf(resolve({ prod: ['all'], dev: ['buzz'] }))).toEqual({
      db: 'prod',
      buzz: 'dev',
    });
  });

  it('rejects a group asked for both ways, and all asked for both ways', () => {
    expect(() => resolve({ prod: ['db'], dev: ['db'] })).toThrow(/both --dev and --prod/);
    expect(() => resolve({ prod: ['all'], dev: ['all'] })).toThrow(/opposite things/);
  });

  it('rejects an unknown group even when all is alongside it', () => {
    expect(() => resolve({ prod: ['bogus'] })).toThrow(/Unknown env group\(s\): bogus/);
    expect(() => resolve({ prod: ['all', 'bogus'] })).toThrow(/Unknown env group\(s\): bogus/);
  });

  it('rejects all when the definitions file defines nothing', () => {
    const empty = { path: 'env-modes.local', exists: false, groups: {}, errors: [] };
    expect(() => resolveSessionModes({ definitions: empty, prod: ['all'], dev: [] })).toThrow(
      /matches no env groups/
    );
  });

  it('skips a group that lacks the mode under all, but not one named beside it', () => {
    const withGap = defs(['[only.dev]', 'K=v', '[db.dev]', 'DATABASE_URL=x'].join('\n'));
    expect(modesOf(resolveSessionModes({ definitions: withGap, prod: ['all'], dev: [] }))).toEqual({
      only: 'dev',
      db: 'dev',
    });
    expect(() =>
      resolveSessionModes({ definitions: withGap, prod: ['all', 'only'], dev: [] })
    ).toThrow(/No \[only\.prod\] section/);
  });

  it('says so when DEVSERVER_PROD_GROUPS names something undefined', () => {
    const { notes } = resolve({ defaultProdGroups: ['buzzz'] });
    expect(notes.join(' ')).toMatch(/buzzz/);
  });
});

describe('the overlay', () => {
  it('applies the chosen mode and leaves everything else alone', () => {
    const dev = applyModes({ OTHER: 'untouched' }, TWO_GROUPS, resolve().modes).envVars;
    const prod = applyModes({}, TWO_GROUPS, resolve({ prod: ['db'] }).modes).envVars;

    expect(dev.OTHER).toBe('untouched');
    expect(dev.DATABASE_URL).toBe('postgres://dev-host/civitai');
    expect(prod.DATABASE_URL).toBe('postgres://prod-host/civitai');
    expect(prod.BUZZ_ENDPOINT).toBe('http://localhost:28081');
  });

  it('carries every key of the group, not just the first', () => {
    expect(
      applyModes({}, TWO_GROUPS, resolve({ prod: ['db'] }).modes).envVars.DATABASE_IS_PROD
    ).toBe('true');
  });
});

describe('the definitions parser', () => {
  it('closes the open section on a malformed header', () => {
    // `[db prod]` matches neither pattern. Leaving the section open would file the production URL
    // under [db.dev], and a bare start would run on production while reporting dev.
    const parsed = parseModeDefinitions(
      ['[db.dev]', 'DATABASE_URL=dev-host', '[db prod]', 'DATABASE_URL=PROD-host'].join('\n')
    );
    expect(parsed.groups.db.dev.DATABASE_URL).toBe('dev-host');
    // Two: the header itself, then the key it orphaned by closing the section.
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toMatch(/line 3/);
    expect(parsed.errors[1]).toMatch(/outside any/);
  });

  it('refuses a group an overlay cannot actually move', async () => {
    // Defining [auth-hub.*] would not move the hub — it reads its own .env — it would only repoint
    // the app at a hub that is not listening, and delete the always-prod warning while doing it.
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'env-modes-'));
    writeFileSync(
      join(dir, 'env-modes.local'),
      '[auth-hub.dev]\nNEXT_PUBLIC_AUTH_URL=http://nope\n'
    );

    const loaded = loadModeDefinitions(dir);
    expect(loaded.groups['auth-hub']).toBeUndefined();
    expect(loaded.errors.join(' ')).toMatch(/auth-hub/);
  });

  it('never echoes the offending line, which may carry a password', () => {
    const stray = parseModeDefinitions('DATABASE_URL=postgres://user:hunter2@host/db');
    const junk = parseModeDefinitions('[db.dev]\npostgres://user:hunter2@host/db\n');
    expect(stray.errors[0]).not.toMatch(/hunter2/);
    expect(junk.errors[0]).not.toMatch(/hunter2/);
  });
});

describe('the summary and the session comparison', () => {
  it('names the services that have no dev target at all', () => {
    expect(formatModeSummary(resolve().modes)).toMatch(
      /always prod \(no dev target\): orchestrator/
    );
  });

  it('stops calling a group prod-only once someone defines it', () => {
    const s3 = defs(
      ['[s3.dev]', 'S3_UPLOAD_BUCKET=dev', '[s3.prod]', 'S3_UPLOAD_BUCKET=prod'].join('\n')
    );
    const summary = formatModeSummary(
      resolveSessionModes({ definitions: s3, prod: [], dev: [] }).modes
    );
    expect(summary).toMatch(/s3=dev/);
    expect(summary).not.toMatch(/no dev target\):.*\bs3\b/);
  });

  it('treats the same resolved modes as the same session however they were spelled', () => {
    expect(
      sameResolvedModes(resolve({ prod: ['all'] }).modes, resolve({ prod: ['db', 'buzz'] }).modes)
    ).toBe(true);
    expect(sameResolvedModes(resolve({ prod: ['db'] }).modes, resolve().modes)).toBe(false);
  });

  it('does not fail a bare start just because a new group was defined', () => {
    // Adding a section to env-modes.local must not make `start` — which is meant to be idempotent —
    // start refusing against every session that was already running.
    const running = resolve().modes;
    const afterEdit = { ...running, mongo: { mode: 'dev' } };
    expect(sameResolvedModes(running, afterEdit)).toBe(true);
  });

  it('refuses to match a request that lost a group the session has', () => {
    // The other direction is the dangerous one: env-modes.local gone (an atomic-rename save mid
    // flight, a git clean) resolves the request to nothing, and an empty request matching a
    // production session is exactly the answer the guard exists to prevent.
    const running = resolve({ prod: ['db'] }).modes;
    expect(sameResolvedModes(running, {})).toBe(false);
    expect(sameResolvedModes(running, resolve({ prod: ['db'] }).modes)).toBe(true);
  });

  it('keeps warning about the auth hub even if someone defines it as a group', () => {
    // Defining [auth-hub.*] cannot move the hub — it is a separate process reading its own .env —
    // so the warning must not be deletable by a config edit.
    const hub = defs(['[auth-hub.dev]', 'X=1', '[auth-hub.prod]', 'X=2'].join('\n'));
    const summary = formatModeSummary(
      resolveSessionModes({ definitions: hub, prod: [], dev: [] }).modes
    );
    expect(summary).toMatch(/always prod \(no dev target\):.*auth-hub/);
  });

  it('says which groups "all" could not move', () => {
    const withGap = defs(['[only.dev]', 'K=v', '[db.dev]', 'D=1', '[db.prod]', 'D=2'].join('\n'));
    const { notes } = resolveSessionModes({ definitions: withGap, prod: ['all'], dev: [] });
    expect(notes.join(' ')).toMatch(/"all" skipped only/);
  });

  it('refuses --dev all when a group cannot go to dev', () => {
    // Skipping is survivable in the prod direction — the group stays on dev. Skipping in the dev
    // direction leaves it on the .env, which is production, so the request asking for safety would
    // be the one that quietly failed to deliver it.
    const prodOnly = defs(['[buzz.prod]', 'BUZZ_ENDPOINT=prod'].join('\n'));
    expect(() => resolveSessionModes({ definitions: prodOnly, prod: [], dev: ['all'] })).toThrow(
      /--dev all cannot move buzz/
    );
  });

  it('does not match a session that resolved nothing against one that resolved groups', () => {
    // A session that came up before env-modes.local existed is running the base .env. Once the file
    // appears, a bare start resolves real modes — the two are not the same session.
    expect(sameResolvedModes({}, resolve().modes)).toBe(false);
    expect(sameResolvedModes({}, {})).toBe(true);
  });

  it('keeps a half-defined prod-only service in the warning', () => {
    // [s3.prod] alone resolves s3 to `base`: nothing applied, the .env value stands, and the .env
    // is production. Dropping it from the tail would under-report exactly then.
    const halfS3 = defs(['[s3.prod]', 'S3_UPLOAD_BUCKET=prod'].join('\n'));
    const summary = formatModeSummary(
      resolveSessionModes({ definitions: halfS3, prod: [], dev: [] }).modes
    );
    expect(summary).toMatch(/s3=base/);
    expect(summary).toMatch(/always prod \(no dev target\):.*\bs3\b/);
  });
});
