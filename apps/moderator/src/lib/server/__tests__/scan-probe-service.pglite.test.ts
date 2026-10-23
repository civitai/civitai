import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import type * as CsamFlagClear from '../csam-flag-clear';
import { Kysely } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { executableSchemaSql, pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The probe's submit path against real tables: the main database's "Image" (cut to the columns the
 * eligibility read touches) and the moderator database's `image_scan_probe_run` from
 * `apps/moderator/scan-probe/schema.sql`. The orchestrator is a fake that records what it was sent.
 */

const SYSTEM_CLIENT = { name: 'system-client' };
const MODERATOR = 424242;
const OTHER_MODERATOR = 515151;
const HELD_OWNER = 9001;

const h = vi.hoisted(() => ({
  main: null as unknown,
  probe: null as unknown,
  submits: [] as Record<string, unknown>[],
  nextIds: [] as (string | null)[],
  workflows: new Map<string, unknown>(),
  /** Workflow ids the fake answers 404 for. */
  gone: new Set<string>(),
  /** When true, every workflow read throws, as an outage does. */
  readThrows: false,
  /** Runs after each submit, inside it: how a test changes the database mid-batch. */
  onSubmit: null as null | (() => Promise<void>),
  held: new Map<number, string[]>(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    return h.main;
  },
  get dbWrite() {
    return h.main;
  },
}));
vi.mock('../moderator-db', () => ({ getModeratorDb: () => ({ withTables: () => h.probe }) }));
vi.mock('../orchestrator', () => ({
  getOrchestratorClient: () => SYSTEM_CLIENT,
  isGoneStatus: (status: number) => status === 404 || status === 410,
}));
vi.mock('../csam-flag-clear', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamFlagClear>()),
  getFlagClearHolds: async (userIds: number[]) =>
    new Map([...h.held].filter(([id]) => userIds.includes(id))),
}));
// Hand-listed: the package's ESM build cannot be loaded under node (a directory import), so
// `importOriginal` is not available for it. These two are all the service imports.
vi.mock('@civitai/orchestration-client', () => ({
  submitWorkflow: async (args: Record<string, unknown>) => {
    h.submits.push(args);
    await h.onSubmit?.();
    const id = h.nextIds.shift() ?? null;
    if (id === 'THROW') throw new Error('timeout');
    return { data: id ? { id } : undefined };
  },
  getWorkflow: async ({ path }: { path: { workflowId: string } }) => {
    if (h.readThrows) throw new Error('outage');
    if (h.gone.has(path.workflowId)) return { data: undefined, response: { status: 404 } };
    const data = h.workflows.get(path.workflowId);
    return { data, response: { status: data ? 200 : 503 } };
  },
}));

const { runProbe, readProbe } = await import('../scan-probe/service');

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_DDL = executableSchemaSql(
  readFileSync(join(HERE, '../../../../scan-probe/schema.sql'), 'utf8')
);

// "Image" cut to what the eligibility read and the relabel exclusion touch, plus the report tables
// that exclusion reads.
const MAIN_DDL = `
CREATE TABLE "Image" (
  id int PRIMARY KEY, "userId" int NOT NULL, url text NOT NULL, type text NOT NULL DEFAULT 'image',
  "needsReview" text, "blockedFor" text
);
CREATE TABLE "Report" (id int PRIMARY KEY, reason text NOT NULL);
CREATE TABLE "ImageReport" ("reportId" int NOT NULL, "imageId" int NOT NULL);
CREATE TABLE "UserReport" ("reportId" int NOT NULL, "userId" int NOT NULL);
CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb NOT NULL DEFAULT '[]');
`;

let mainPg: PGlite;
let probePg: PGlite;

beforeAll(async () => {
  process.env.PUBLIC_IMAGE_LOCATION = 'https://image.example.test/acct';
  [mainPg, probePg] = await Promise.all([freshPglite(), freshPglite()]);
  await mainPg.exec(MAIN_DDL);
  await probePg.exec(PROBE_DDL);
  h.main = new Kysely({ dialect: pgliteDialect(mainPg) });
  h.probe = new Kysely({ dialect: pgliteDialect(probePg) });
}, 60_000);

beforeEach(async () => {
  await mainPg.exec('TRUNCATE "Image", "Report", "ImageReport", "UserReport", "CsamReport"');
  await probePg.exec('TRUNCATE image_scan_probe_run RESTART IDENTITY');
  h.submits = [];
  h.nextIds = [];
  h.workflows.clear();
  h.gone.clear();
  h.readThrows = false;
  h.onSubmit = null;
  h.held.clear();
  await mainPg.exec(`INSERT INTO "Image" (id, "userId", url, type, "needsReview", "blockedFor") VALUES
    (777001, 10, 'clean-key-1', 'image', NULL, NULL),
    (777002, 10, 'clean-key-2', 'image', NULL, NULL),
    (777003, 11, 'flagged-key', 'image', 'csam', NULL),
    (777004, 12, 'blocked-key', 'image', NULL, 'CSAM'),
    (777005, ${HELD_OWNER}, 'held-key', 'image', NULL, NULL),
    (777006, 10, 'video-key', 'video', NULL, NULL),
    (777007, 10, 'https://evil.example/x.png', 'image', NULL, NULL)`);
});

const rows = async () =>
  (
    await probePg.query<{
      id: number;
      moderator_id: number;
      image_id: number;
      status: string;
      workflow_id: string | null;
      workflow_status: string | null;
      tripped: boolean;
      nsfw_level: string | null;
      blocked_reason: string | null;
      csam: boolean | null;
      cached: string;
    }>('SELECT * FROM image_scan_probe_run ORDER BY id')
  ).rows;

const finished = (status: string, output: Record<string, unknown>) => ({
  status,
  steps: [{ $type: 'imageScanning', output }],
});

describe('runProbe: what reaches the orchestrator', () => {
  it('submits with the system client, and nothing in the request names the moderator or the image', async () => {
    h.nextIds = ['0-wf-1'];
    const result = await runProbe(MODERATOR, [777001]);
    expect(result).toEqual({ ok: true, submitted: 1, failed: 0, stopped: false, refused: [] });
    expect(h.submits).toHaveLength(1);
    const [args] = h.submits;
    expect(args.client).toBe(SYSTEM_CLIENT);
    expect(Object.keys(args).sort()).toEqual(['body', 'client', 'signal']);
    const body = JSON.stringify(args.body);
    expect(body).not.toContain(String(MODERATOR));
    expect(body).not.toContain('777001');
  });

  it('writes the audit row before the submit, and submits nothing when it cannot', async () => {
    // Refuses the insert only: reads still work, so the run gets as far as the audit write.
    await probePg.exec(
      'ALTER TABLE image_scan_probe_run ADD CONSTRAINT refuse_insert CHECK (image_id < 0) NOT VALID'
    );
    try {
      await expect(runProbe(MODERATOR, [777001])).rejects.toThrow(/refuse_insert/);
      expect(h.submits).toHaveLength(0);
    } finally {
      await probePg.exec('ALTER TABLE image_scan_probe_run DROP CONSTRAINT refuse_insert');
    }
  });

  it('records the workflow id on the run row', async () => {
    h.nextIds = ['0-wf-1'];
    await runProbe(MODERATOR, [777001]);
    expect(await rows()).toMatchObject([
      {
        moderator_id: MODERATOR,
        image_id: 777001,
        status: 'submitted',
        workflow_id: '0-wf-1',
        cached: 'unknown',
      },
    ]);
  });
});

// Decision: a probe copies the bytes into orchestrator storage, and CSAM-class bytes are never
// copied outside the evidence path. Each leg is one way an image is known to be in that class.
describe('runProbe: images it refuses, with no reason given', () => {
  it.each([
    ['flagged for CSAM review', 777003],
    ['blocked for CSAM', 777004],
    ['owned by a held user', 777005],
  ])('refuses an image %s', async (_label, imageId) => {
    h.held.set(HELD_OWNER, ['evidenceHold']);
    h.nextIds = ['0-wf-1'];
    const result = await runProbe(MODERATOR, [777001, imageId]);
    expect(result).toMatchObject({ ok: true, submitted: 1, refused: [imageId] });
    expect((await rows()).map((r) => r.image_id)).toEqual([777001]);
  });

  it('refuses a video, an absolute url and a missing image the same way', async () => {
    const result = await runProbe(MODERATOR, [777006, 777007, 123]);
    expect(result).toEqual({
      ok: false,
      reason: 'nothing-eligible',
      refused: [777006, 777007, 123],
    });
    expect(h.submits).toHaveLength(0);
    expect(await rows()).toEqual([]);
  });

  it('refuses an image a CSAM report lists, though nothing on the image or its owner is flagged', async () => {
    await mainPg.exec(
      `INSERT INTO "CsamReport" ("userId", images) VALUES (99, '[{"id": 777002}]')`
    );
    h.nextIds = ['0-wf-1'];
    expect(await runProbe(MODERATOR, [777001, 777002])).toMatchObject({
      ok: true,
      refused: [777002],
    });
  });

  it('control: submits an image whose owner holds nothing while another owner is held', async () => {
    h.held.set(4242, ['evidenceHold']);
    h.nextIds = ['0-wf-1'];
    expect(await runProbe(MODERATOR, [777005])).toMatchObject({
      ok: true,
      submitted: 1,
      refused: [],
    });
  });
});

describe('runProbe: the breaker', () => {
  it('stops at the first workflow that is not the system account, and submits nothing after it', async () => {
    h.nextIds = ['7-wf-1', '0-wf-2'];
    const result = await runProbe(MODERATOR, [777001, 777002]);
    expect(result).toMatchObject({ ok: false, reason: 'wrong-account' });
    expect(h.submits).toHaveLength(1);
    expect(await rows()).toMatchObject([
      { image_id: 777001, workflow_status: 'wrong-account', tripped: true },
      { image_id: 777002, status: 'submit-failed', tripped: false },
    ]);
  });

  it('refuses every later run while tripped, until an admin resets it', async () => {
    h.nextIds = ['7-wf-1'];
    await runProbe(MODERATOR, [777001]);
    h.nextIds = ['0-wf-2'];
    expect(await runProbe(OTHER_MODERATOR, [777002])).toMatchObject({
      ok: false,
      reason: 'breaker',
    });
    expect(h.submits).toHaveLength(1);

    const { resetBreaker } = await import('../scan-probe/runs');
    expect(await resetBreaker(h.probe as never, 1, ['1'])).toBe(1);
    expect(await runProbe(OTHER_MODERATOR, [777002])).toMatchObject({ ok: true, submitted: 1 });
  });

  it('brings in an unpolled verdict before the next run, and a block trips it', async () => {
    h.nextIds = ['0-wf-1'];
    await runProbe(MODERATOR, [777001]);
    h.workflows.set(
      '0-wf-1',
      finished('succeeded', { nsfwLevel: 'x', csam: null, blockedReason: 'some reason' })
    );
    h.nextIds = ['0-wf-2'];
    expect(await runProbe(MODERATOR, [777002])).toMatchObject({ ok: false, reason: 'breaker' });
    expect(h.submits).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({
      workflow_status: 'succeeded',
      nsfw_level: 'x',
      blocked_reason: 'some reason',
      tripped: true,
    });
  });

  it('refuses a new batch while an earlier one is still running', async () => {
    h.nextIds = ['0-wf-1'];
    await runProbe(MODERATOR, [777001]);
    h.workflows.set('0-wf-1', { status: 'processing', steps: [] });
    expect(await runProbe(OTHER_MODERATOR, [777002])).toMatchObject({
      ok: false,
      reason: 'in-flight',
    });
  });

  it('lets the next batch through once the last one finished clean', async () => {
    h.nextIds = ['0-wf-1'];
    await runProbe(MODERATOR, [777001]);
    h.workflows.set(
      '0-wf-1',
      finished('succeeded', { nsfwLevel: 'pg', csam: false, blockedReason: null })
    );
    h.nextIds = ['0-wf-2'];
    expect(await runProbe(MODERATOR, [777002])).toMatchObject({ ok: true, submitted: 1 });
    expect((await rows())[0]).toMatchObject({ csam: false, tripped: false });
  });
});

// Decision: an outcome the probe cannot read is treated as a block, never as "nothing happened".
// The scan may have run; if it blocked the image it may have struck the account.
describe('runProbe: outcomes it cannot read hold or trip the probe', () => {
  it.each([
    ['answers with no id', null],
    ['throws (a timeout)', 'THROW'],
  ])('trips when a submit %s, and sends nothing after it', async (_label, answer) => {
    h.nextIds = [answer, '0-wf-2'];
    expect(await runProbe(MODERATOR, [777001, 777002])).toEqual({
      ok: true,
      submitted: 0,
      failed: 2,
      stopped: true,
      refused: [],
    });
    expect(h.submits).toHaveLength(1);
    expect(await rows()).toMatchObject([
      { status: 'submit-failed', workflow_status: 'unknown-submit', tripped: true },
      { status: 'submit-failed', workflow_status: null, tripped: false },
    ]);
    expect(await runProbe(MODERATOR, [777001])).toMatchObject({ ok: false, reason: 'breaker' });
  });

  it('trips on a workflow the orchestrator says does not exist', async () => {
    h.nextIds = ['0-wf-1'];
    await runProbe(MODERATOR, [777001]);
    h.gone.add('0-wf-1');
    expect(await runProbe(MODERATOR, [777002])).toMatchObject({ ok: false, reason: 'breaker' });
    expect((await rows())[0]).toMatchObject({ workflow_status: 'gone', tripped: true });
  });

  it('holds, without tripping, while the orchestrator cannot be asked — however old the run', async () => {
    h.nextIds = ['0-wf-1'];
    await runProbe(MODERATOR, [777001]);
    await probePg.exec(`UPDATE image_scan_probe_run SET created_at = now() - interval '3 days'`);
    h.readThrows = true;
    expect(await runProbe(MODERATOR, [777002])).toMatchObject({ ok: false, reason: 'in-flight' });
    expect((await rows())[0]).toMatchObject({ workflow_status: null, tripped: false });
  });

  it('holds, without tripping, when the orchestrator answers with an error that is not a 404', async () => {
    h.nextIds = ['0-wf-1'];
    await runProbe(MODERATOR, [777001]);
    expect(await runProbe(MODERATOR, [777002])).toMatchObject({ ok: false, reason: 'in-flight' });
    expect((await rows())[0]).toMatchObject({ workflow_status: null, tripped: false });
  });

  it('trips on a pending row nobody settled, and holds on a fresh one', async () => {
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, created_at)
      VALUES (1, 1, now() - interval '1 minute')`);
    expect(await runProbe(MODERATOR, [777001])).toMatchObject({ ok: false, reason: 'in-flight' });
    await probePg.exec(
      `UPDATE image_scan_probe_run SET created_at = now() - interval '11 minutes'`
    );
    expect(await runProbe(MODERATOR, [777001])).toMatchObject({ ok: false, reason: 'breaker' });
    expect((await rows())[0]).toMatchObject({
      status: 'submit-failed',
      workflow_status: 'abandoned',
      tripped: true,
    });
  });

  it('stops mid-batch when the breaker trips after the batch began', async () => {
    h.nextIds = ['0-wf-1', '0-wf-2'];
    h.onSubmit = async () => {
      await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_status, tripped)
        VALUES (1, 1, 'submit-failed', 'gone', true)`);
      h.onSubmit = null;
    };
    expect(await runProbe(MODERATOR, [777001, 777002])).toMatchObject({
      ok: true,
      submitted: 1,
      failed: 1,
      stopped: true,
    });
    expect(h.submits).toHaveLength(1);
  });

  it('trips a run it sent but could not record, because its row was swept meanwhile', async () => {
    h.nextIds = ['0-wf-1'];
    h.onSubmit = async () => {
      await probePg.exec(
        `UPDATE image_scan_probe_run SET status = 'submit-failed', workflow_status = 'abandoned'`
      );
    };
    await runProbe(MODERATOR, [777001]);
    expect((await rows())[0]).toMatchObject({ tripped: true });
  });

  it('records a wrong-account trip in the same write as the id, so a reconcile cannot clear it', async () => {
    h.nextIds = ['7-wf-1'];
    h.workflows.set(
      '7-wf-1',
      finished('succeeded', { nsfwLevel: 'pg', csam: false, blockedReason: null })
    );
    await runProbe(MODERATOR, [777001]);
    expect((await rows())[0]).toMatchObject({
      status: 'submitted',
      workflow_id: '7-wf-1',
      workflow_status: 'wrong-account',
      tripped: true,
    });
  });
});

describe('admin recovery', () => {
  it('resets only the trips it was shown; one that landed later still holds', async () => {
    const { resetBreaker } = await import('../scan-probe/runs');
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_status, tripped) VALUES
      (1, 1, 'submit-failed', 'gone', true), (1, 2, 'submit-failed', 'gone', true)`);
    expect(await resetBreaker(h.probe as never, 7, ['1'])).toBe(1);
    expect(await runProbe(MODERATOR, [777001])).toMatchObject({ ok: false, reason: 'breaker' });
  });

  it('releases runs whose verdict will never arrive, recording the admin', async () => {
    const { abandonInFlight } = await import('../scan-probe/runs');
    h.nextIds = ['0-wf-1'];
    await runProbe(MODERATOR, [777001]);
    h.readThrows = true;
    expect(await runProbe(MODERATOR, [777002])).toMatchObject({ ok: false, reason: 'in-flight' });
    expect(await abandonInFlight(h.probe as never, 7, ['1'])).toBe(1);
    expect((await rows())[0]).toMatchObject({
      workflow_status: 'abandoned-by-admin',
      tripped: true,
    });
    h.readThrows = false;
    h.nextIds = ['0-wf-2'];
    expect(await runProbe(MODERATOR, [777002])).toMatchObject({ ok: true, submitted: 1 });
  });
});

describe('runProbe: rate limits', () => {
  it("counts only this moderator's last hour toward their limit, up to and including it", async () => {
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id, workflow_status)
      SELECT ${MODERATOR}, g, 'submitted', '0-x' || g, 'succeeded' FROM generate_series(1, 99) g`);
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id, workflow_status)
      SELECT ${OTHER_MODERATOR}, g, 'submitted', '0-y' || g, 'succeeded' FROM generate_series(1, 100) g`);
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id, workflow_status, created_at)
      SELECT ${MODERATOR}, g, 'submitted', '0-z' || g, 'succeeded', now() - interval '61 minutes' FROM generate_series(1, 10) g`);
    h.nextIds = ['0-wf-1'];
    expect(await runProbe(MODERATOR, [777001])).toMatchObject({ ok: true, submitted: 1 });
  });

  it('refuses a batch that would pass the moderator hourly limit, writing nothing', async () => {
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id, workflow_status)
      SELECT ${MODERATOR}, g, 'submitted', '0-x' || g, 'succeeded' FROM generate_series(1, 100) g`);
    expect(await runProbe(MODERATOR, [777001])).toMatchObject({
      ok: false,
      reason: 'moderator-hourly',
    });
    expect(h.submits).toHaveLength(0);
  });

  it('refuses a batch that would pass the global daily limit', async () => {
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id, workflow_status, created_at)
      SELECT g, g, 'submitted', '0-x' || g, 'succeeded', now() - interval '2 hours' FROM generate_series(1, 500) g`);
    expect(await runProbe(MODERATOR, [777001])).toMatchObject({
      ok: false,
      reason: 'global-daily',
    });
  });
});

describe('recordOutcome', () => {
  it('records a verdict once; a second call changes nothing', async () => {
    const { recordOutcome } = await import('../scan-probe/runs');
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id)
      VALUES (1, 1, 'submitted', '0-a')`);
    const db = h.probe as never;
    expect(
      await recordOutcome(db, '1', {
        workflowStatus: 'succeeded',
        verdict: { nsfwLevel: 'pg', blockedReason: null, csam: false },
        tripped: false,
      })
    ).toBe(true);
    expect(
      await recordOutcome(db, '1', { workflowStatus: 'failed', verdict: null, tripped: true })
    ).toBe(false);
    expect((await rows())[0]).toMatchObject({ workflow_status: 'succeeded', tripped: false });
  });
});

describe('readProbe', () => {
  it('reports a pending row, a failed submit and a running workflow as such', async () => {
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id) VALUES
      (${MODERATOR}, 1, 'pending', NULL),
      (${MODERATOR}, 2, 'submit-failed', NULL),
      (${MODERATOR}, 3, 'submitted', '0-run')`);
    h.workflows.set('0-run', { status: 'processing', steps: [] });
    expect(await readProbe('1', MODERATOR)).toEqual({ state: 'pending' });
    expect(await readProbe('2', MODERATOR)).toEqual({ state: 'submit-failed' });
    expect(await readProbe('3', MODERATOR)).toEqual({
      state: 'running',
      workflowStatus: 'processing',
    });
  });

  it('keeps polling through an outage instead of reporting the run gone', async () => {
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id)
      VALUES (${MODERATOR}, 1, 'submitted', '0-run')`);
    h.readThrows = true;
    expect(await readProbe('1', MODERATOR)).toEqual({
      state: 'running',
      workflowStatus: 'unknown',
    });
  });

  it('trips a run the orchestrator says is gone, and reports it unavailable', async () => {
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id)
      VALUES (${MODERATOR}, 1, 'submitted', '0-run')`);
    h.gone.add('0-run');
    expect(await readProbe('1', MODERATOR)).toEqual({ state: 'unavailable' });
    expect((await rows())[0]).toMatchObject({ workflow_status: 'gone', tripped: true });
  });

  it('records and trips a blocked verdict when the page is the first to read it', async () => {
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id)
      VALUES (${MODERATOR}, 1, 'submitted', '0-run')`);
    h.workflows.set(
      '0-run',
      finished('succeeded', { nsfwLevel: 'x', csam: true, blockedReason: null })
    );
    expect(await readProbe('1', MODERATOR)).toMatchObject({
      state: 'done',
      signals: { csam: true },
    });
    expect((await rows())[0]).toMatchObject({ csam: true, tripped: true });
  });

  it('says a sent submit with no answer is unknown, not failed', async () => {
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_status, tripped)
      VALUES (${MODERATOR}, 1, 'submit-failed', 'unknown-submit', true)`);
    expect(await readProbe('1', MODERATOR)).toEqual({ state: 'unknown' });
  });

  it('serves a recorded verdict once the orchestrator has purged the workflow', async () => {
    await probePg.exec(`INSERT INTO image_scan_probe_run (moderator_id, image_id, status, workflow_id, workflow_status)
      VALUES (${MODERATOR}, 1, 'submitted', '0-run', 'succeeded')`);
    h.gone.add('0-run');
    expect(await readProbe('1', MODERATOR)).toEqual({
      state: 'done',
      workflowStatus: 'succeeded',
      signals: null,
    });
  });

  it("reads a moderator's own run and never another's", async () => {
    h.nextIds = ['0-wf-1'];
    await runProbe(MODERATOR, [777001]);
    h.workflows.set(
      '0-wf-1',
      finished('succeeded', { nsfwLevel: 'pg', csam: false, blockedReason: null })
    );
    expect(await readProbe('1', OTHER_MODERATOR)).toBeNull();
    expect(await readProbe('1', MODERATOR)).toMatchObject({
      state: 'done',
      workflowStatus: 'succeeded',
      signals: { nsfwLevel: 'pg', csam: false },
    });
  });
});
