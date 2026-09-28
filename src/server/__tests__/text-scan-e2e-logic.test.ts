import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEXT_SCAN_FLAG } from '~/server/services/text-scan/mode';
import {
  classifyScanRow,
  clockSkewError,
  devDbFingerprintError,
  jobRunError,
  modeMismatches,
  observedPhase,
  parseE2eEnv,
  parseUtcTimestamp,
  TEXT_SCAN_ENTITY_TYPES,
} from '../../../tests/text-scan/logic';

const FILE = {
  TEXT_SCAN_E2E_BASE_URL: 'http://localhost:3000',
  TEXT_SCAN_E2E_MODERATOR_URL: 'http://localhost:3001',
  TEXT_SCAN_E2E_HUB_URL: 'http://localhost:3002',
  TEXT_SCAN_E2E_DB_URL: 'postgresql://u:p@localhost:6546/civitai',
  TEXT_SCAN_E2E_CALLBACK_ORIGIN: 'https://tunnel.example',
  WEBHOOK_TOKEN: 'file-token',
  AUTH_INTERNAL_TOKEN: 'internal',
};

describe('parseE2eEnv', () => {
  it('takes the phase from the command line and everything else from the file first', () => {
    const env = parseE2eEnv(
      { TEXT_SCAN_E2E_PHASE: 'active', WEBHOOK_TOKEN: 'shell-token' },
      FILE,
      'e2e.env'
    );
    expect(env.TEXT_SCAN_E2E_PHASE).toBe('active');
    expect(env.WEBHOOK_TOKEN).toBe('file-token');
  });

  it('refuses a phase written into the file', () => {
    expect(() =>
      parseE2eEnv(
        { TEXT_SCAN_E2E_PHASE: 'shadow' },
        { ...FILE, TEXT_SCAN_E2E_PHASE: 'active' },
        'e2e.env'
      )
    ).toThrow(/must not set TEXT_SCAN_E2E_PHASE/);
  });

  it('names the file and the missing keys', () => {
    let message = '';
    try {
      parseE2eEnv({}, {}, 'tests/text-scan/local/e2e.env');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('tests/text-scan/local/e2e.env');
    expect(message).toContain('TEXT_SCAN_E2E_PHASE');
    expect(message).toContain('TEXT_SCAN_E2E_DB_URL');
  });
});

describe('parseUtcTimestamp', () => {
  // A non-UTC zone, so a parse that fell back to local time would be visible on a UTC CI box.
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles';
  });
  afterAll(() => {
    process.env.TZ = zone;
  });

  it('reads timestamp-without-zone text as UTC whatever the local zone', () => {
    expect(parseUtcTimestamp('2026-09-28 10:11:12.345').toISOString()).toBe(
      '2026-09-28T10:11:12.345Z'
    );
    expect(parseUtcTimestamp('2026-09-28 10:11:12.345678').toISOString()).toBe(
      '2026-09-28T10:11:12.345Z'
    );
    expect(parseUtcTimestamp('2026-09-28 10:11:12').toISOString()).toBe('2026-09-28T10:11:12.000Z');
  });

  it('throws on text it cannot read', () => {
    expect(() => parseUtcTimestamp('infinity')).toThrow(/unparseable/);
  });
});

describe('clockSkewError', () => {
  const db = new Date('2026-09-28T10:00:00.000Z');
  it('passes inside the tolerance and fails outside it, in either direction', () => {
    expect(clockSkewError(db, db.getTime() + 1_500, 2_000)).toBeNull();
    expect(clockSkewError(db, db.getTime() - 2_500, 2_000)).toMatch(/-2500ms off/);
    expect(clockSkewError(db, db.getTime() + 2_500, 2_000)).toMatch(/2500ms off/);
  });
});

describe('devDbFingerprintError', () => {
  it('refuses a DB whose newest user is younger than the threshold', () => {
    expect(devDbFingerprintError(12, 600)).toMatch(/not the dev clone/);
    expect(devDbFingerprintError(null, 600)).toMatch(/no User rows/);
    expect(devDbFingerprintError(3 * 86_400, 600)).toBeNull();
  });
});

describe('jobRunError', () => {
  it('passes only a 200 whose body says ok with no error', () => {
    expect(jobRunError('j', 200, { ok: true, result: null })).toBeNull();
  });

  it.each([
    [404, { ok: false, error: 'Job not found' }, /not registered/],
    [500, { ok: false, error: {} }, /HTTP 500/],
    [200, { ok: false }, /failed/],
    [200, 'not json', /failed/],
    [200, { ok: true, error: 'Job already running' }, /did not run: Job already running/],
  ])('status %s body %j throws %s', (status, body, message) => {
    expect(jobRunError('j', status, body)).toMatch(message);
  });
});

describe('modeMismatches', () => {
  it('covers exactly the entity types the server has flags for', () => {
    expect([...TEXT_SCAN_ENTITY_TYPES].sort()).toEqual(Object.keys(TEXT_SCAN_FLAG).sort());
  });

  it('lists every type not in the expected mode, including missing ones', () => {
    const modes: Record<string, string> = Object.fromEntries(
      TEXT_SCAN_ENTITY_TYPES.map((t) => [t, 'shadow'])
    );
    expect(modeMismatches(modes, 'shadow')).toEqual([]);
    modes.ChatMessage = 'off';
    delete modes.User;
    expect(modeMismatches(modes, 'shadow')).toEqual(['ChatMessage=off', 'User=missing']);
    expect(modeMismatches(modes, 'active')).toHaveLength(12);
  });
});

describe('classifyScanRow', () => {
  const row = (status: string, workflowId: string | null = 'wf-2', version?: number) => ({
    status,
    workflowId,
    result: version === undefined ? null : { version },
  });

  it('is done only on a Succeeded text-scan verdict', () => {
    expect(classifyScanRow(row('Succeeded', 'wf-2', 1))).toBe('done');
    expect(classifyScanRow(row('Succeeded', 'wf-2'))).toBe('pending');
    expect(classifyScanRow(row('Pending'))).toBe('pending');
    expect(classifyScanRow(undefined)).toBe('pending');
  });

  it('fails at once on a terminal non-success', () => {
    for (const status of ['Failed', 'Expired', 'Canceled'])
      expect(classifyScanRow(row(status))).toBe('failed');
  });

  it('keeps waiting while the row still carries the previous workflow', () => {
    expect(classifyScanRow(row('Succeeded', 'wf-1', 1), 'wf-1')).toBe('pending');
    expect(classifyScanRow(row('Succeeded', 'wf-2', 1), 'wf-1')).toBe('done');
    expect(classifyScanRow(row('Succeeded', null, 1), null)).toBe('pending');
  });
});

describe('observedPhase', () => {
  const verdict = { status: 'Succeeded', workflowId: 'wf', result: { version: 1 } };
  const xguard = { status: 'Succeeded', workflowId: 'wf-x', result: null };
  it('reads the phase off which row got the text-scan verdict', () => {
    expect(observedPhase({ live: xguard, shadow: verdict })).toBe('shadow');
    expect(observedPhase({ live: verdict })).toBe('active');
    expect(observedPhase({ live: xguard })).toBeNull();
  });
});
