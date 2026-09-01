import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => true),
  fetch: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mocks.isFlipt,
  FLIPT_FEATURE_FLAGS: { AUTO_FEATURE_IMAGES: 'auto-feature-images' },
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({ name, cron, run: fn }),
}));

import {
  autoFeatureHealthCheckJob,
  evaluateAutoFeatureHealth,
  readAutoFeatureHealth,
} from '~/server/jobs/auto-feature-health-check';
import { AUTO_FEATURE_JOB_DATE_KEY } from '~/server/common/auto-feature';
import { autoFeatureSchema } from '~/server/schema/home-block.schema';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const WEBHOOK = 'https://discord.test/webhook';

const NOW = new Date('2026-09-01T18:00:00Z');
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** Today's production config: 6h interval, live writes, target collection 107. */
const CONFIG = { collectionId: 107, intervalHours: 6, dryRun: false, perRun: 5 };

/**
 * Drives the job's three reads: the home block's config, the `KeyValue` heartbeat, and the raw
 * `max(...)` over the target collection. Declared per-test rather than defaulted to healthy, so a
 * test that forgets to say what the database holds fails rather than inheriting a green.
 */
function stateIs({
  config = CONFIG as Record<string, unknown> | null,
  lastRun,
  lastRow,
}: {
  config?: Record<string, unknown> | null;
  lastRun: Date | null;
  lastRow: Date | null;
}) {
  dbMock.dbRead.homeBlock.findFirst.mockResolvedValue(
    config === null ? null : { metadata: { featuredCollections: { autoFeature: config } } }
  );
  dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 9001 });
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(
    lastRun === null ? null : { key: AUTO_FEATURE_JOB_DATE_KEY, value: lastRun.getTime() }
  );
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ lastRow }]);
}

/** The tagged-template args the job hands the database: [strings, ...binds]. */
function rowQuery() {
  const [strings, ...binds] = dbMock.dbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
  return { sql: strings.join('?'), binds };
}

function axiom(type: 'warning' | 'info') {
  return loggingMock.logToAxiom.mock.calls
    .map(([arg]) => arg as { type?: string; name?: string; message?: string })
    .filter((arg) => arg.name === 'auto-feature-health-check' && arg.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  // `checkAutoFeatureHealth` reads the real clock, and every timestamp below is relative to a fixed
  // literal — so without this the gap between them grows in real time and the tests asserting a
  // healthy pipeline expire. They passed until 2026-09-02T00:00:00Z and would then have failed on
  // their own, hours after the last commit, looking like a regression in the code they cover.
  // Only Date is faked: faking timers wholesale would stall the async paths under test.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.isFlipt.mockResolvedValue(true);
  // Restored, not just cleared. `vi.clearAllMocks()` drops call records but keeps implementations,
  // so a test that stubs a 404 leaks it into every test after it in this file and the suite goes
  // green by ordering accident.
  mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));
  // Declared rather than replacing the whole module: `~/env/server` exports one `env` object of
  // ~200 keys, so a full replacement gives `undefined` for anything the graph later reads, which
  // is silently wrong rather than a loud missing-export error.
  setEnv({ DISCORD_WEBHOOK_MOD_ALERTS: WEBHOOK });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The request `notifyModAlert` actually emitted, rather than the fact that fetch was called. */
function discordCall() {
  const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
}

describe('auto-feature-health-check reads state the producer does not have to be alive for', () => {
  it('watches the same KeyValue row the job advances', async () => {
    stateIs({ lastRun: hoursBefore(1), lastRow: hoursBefore(1) });

    await autoFeatureHealthCheckJob.run();

    // Pinned as a literal, not as the shared constant: the value lives in a production table, so a
    // rename has to be a deliberate edit here rather than a silent rename on both sides that
    // leaves the check watching a key nothing writes.
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledWith({
      where: { key: 'job:auto-feature-images' },
    });
  });

  it('reads the key the PRODUCER writes, not merely a key of its own', async () => {
    // The assertion above pins one side. On its own it is satisfied by a health check that agrees
    // with itself: point `auto-feature-images` at a different key and every suite here stays green
    // while the check reads a row nothing writes and pages forever.
    //
    // No other getJobDate caller uses a `job:` prefix, so this key is the odd one out and
    // normalising it is the plausible edit. Both sides are read from source
    // here because the producer has no suite of its own to assert it in.
    const producer = readFileSync(resolve(__dirname, '../auto-feature-images.ts'), 'utf-8');
    // First identifier only. `getJobDate(key, defaultValue?)` takes a second optional argument, so
    // capturing to the closing paren reddens on a behaviour-neutral edit with a message that blames
    // the edit rather than this regex.
    const call = producer.match(/getJobDate\(\s*([A-Za-z_$][\w$]*)/);

    expect(call?.[1]).toBe('AUTO_FEATURE_JOB_DATE_KEY');
    expect(AUTO_FEATURE_JOB_DATE_KEY).toBe('job:auto-feature-images');
  });

  it('dates a row the way the producer does, by COALESCE rather than one column', async () => {
    stateIs({ lastRun: hoursBefore(1), lastRow: hoursBefore(1) });

    await autoFeatureHealthCheckJob.run();

    const { sql, binds } = rowQuery();
    // max(reviewedAt) and max(createdAt) taken separately are a different value, and agree only
    // while reviewedAt happens to be null — which is exactly how this would pass in a test and
    // drift in production.
    expect(sql).toMatch(/max\(COALESCE\(ci\."reviewedAt", ci\."createdAt"\)\)/);
    // Ordered, not `toContain`: the collection id and the user id are both plain integers, so a
    // membership assertion passes just as well with the two binds swapped into each other's column.
    expect(binds).toEqual([107, 9001, 'auto-featured:%']);
  });

  it('ignores tombstoned rows, so removing a feature cannot pass for writing one', async () => {
    stateIs({ lastRun: hoursBefore(1), lastRow: hoursBefore(1) });

    await autoFeatureHealthCheckJob.run();

    // Removal sets status REJECTED and stamps reviewedAt = now(), keeping addedById and the note.
    // Without this filter a moderator clearing stale features — what someone does precisely while
    // the pipeline is dry — moves lastRow to the present and silences the check for good.
    // The operator is part of the assertion. Without `AND`, mutating it to `OR` matches this regex
    // just as well while `max(...)` starts ranging over rows outside the collection and attribution
    // filters — green, silent, and defeating the very thing this test is named for.
    expect(rowQuery().sql).toMatch(/AND\s+ci\.status = 'ACCEPTED'::"CollectionItemStatus"/);
    // Asserted as text, not via the binds: `LIKE` -> `NOT LIKE` leaves the bound values identical,
    // so the ordered bind check below cannot see it, and `lastRow` would silently become the newest
    // CURATOR row instead. With `$queryRaw` mocked, the emitted SQL is the only observable there is.
    expect(rowQuery().sql).toMatch(/AND\s+ci\.note LIKE /);
    // Structural, and the reason this is not a fourth clause-by-clause assertion: pinning the
    // operator in front of each clause I could see left the `collectionId`/`addedById` conjunction
    // unguarded, and `OR` there makes max() range over every row in the collection. Enumeration
    // closes the clauses that exist today; this closes the ones added later too. The query
    // legitimately contains no OR, so if one is ever needed this fails loudly and someone decides.
    //
    // String.raw is load-bearing. Written as a plain literal through a shell heredoc this became a
    // regex with LITERAL BACKSPACE bytes where the word boundaries belong, matching nothing and
    // passing forever. Caught only because the mutant was run rather than assumed.
    expect(rowQuery().sql).not.toMatch(new RegExp(String.raw`\bOR\b`, 'i'));
  });

  it('derives the threshold from the configured interval rather than a constant', async () => {
    stateIs({ config: { ...CONFIG, intervalHours: 6 }, lastRun: NOW, lastRow: NOW });
    const at6 = await readAutoFeatureHealth();

    stateIs({ config: { ...CONFIG, intervalHours: 24 }, lastRun: NOW, lastRow: NOW });
    const at24 = await readAutoFeatureHealth();

    // The cadence is tunable without a deploy, so a hardcoded threshold silently stops matching it.
    expect(at6.staleAfterHours).toBe(13);
    expect(at24.staleAfterHours).toBe(49);
  });

  it('still checks when the config has gone missing, at the schema default cadence', async () => {
    stateIs({ config: null, lastRun: hoursBefore(80), lastRow: hoursBefore(80) });

    const result = await autoFeatureHealthCheckJob.run();

    // A vanished config is itself a fault the producer cannot report while it is not running.
    // Refusing to check without one would blind this job to precisely that case.
    //
    // Derived from the schema rather than written as 13: the fallback claims to match the cadence
    // the job would itself have run at, and asserting a literal here cannot see the schema default
    // moving out from under it — which is the only way that claim can become false.
    // Per-field, matching the 🔴 in `auto-feature.ts`: parsing the whole schema to read one default
    // couples this assertion to all thirteen fields and reddens here, blaming the health check, the
    // moment any of them gains a requirement.
    const schemaDefault = autoFeatureSchema.shape.intervalHours.parse(undefined);
    expect(result).toMatchObject({ healthy: false, staleAfterHours: schemaDefault * 2 + 1 });
  });
});

describe('auto-feature-health-check alerting', () => {
  it('stays quiet on a live pipeline', async () => {
    stateIs({ lastRun: hoursBefore(0.7), lastRow: hoursBefore(0.7) });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: true });
    expect(axiom('warning')).toHaveLength(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('pages on a repeat of the 79-hour August outage', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, paged: 1 });
    expect(axiom('warning')[0].message).toContain('No completed run');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('pages when the job has never run at all', async () => {
    // A missing heartbeat and a months-old one are the same outage from the homepage's side.
    // Treating null as inconclusive is how a check that cannot fire gets written.
    stateIs({ lastRun: null, lastRow: null });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, paged: 1 });
    expect(axiom('warning')[0].message).toContain('No completed run');
  });

  it('does not page on the ordinary 7-hour spacing between runs', async () => {
    // The producer wakes hourly and fires on a 6h interval, so 7h is the real observed gap. A
    // threshold at or below it would page several times a day and be turned off.
    stateIs({ lastRun: hoursBefore(7), lastRow: hoursBefore(7) });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('records a running-but-dry pipeline without paging for it', async () => {
    stateIs({ lastRun: hoursBefore(1), lastRow: hoursBefore(40) });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, alerts: 1, paged: 0 });
    expect(axiom('info')[0].message).toContain('Running but not writing');
    // Caps refusing everything is legitimate. Paging on it is how an alert gets muted.
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('blames a dead job once, not twice', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });

    const result = await autoFeatureHealthCheckJob.run();

    // The rows are stale BECAUSE the job is dead. A second line naming the caps would name a
    // cause that is not the one, and send whoever reads it to the wrong place.
    expect(result).toMatchObject({ alerts: 1 });
    expect(axiom('warning')[0].message).not.toContain('Running but not writing');
  });

  it('does not treat a dry run as a stopped one', async () => {
    stateIs({ config: { ...CONFIG, dryRun: true }, lastRun: hoursBefore(1), lastRow: null });

    const result = await autoFeatureHealthCheckJob.run();

    // dryRun writes nothing by design, so the row check has nothing to say. The heartbeat still does.
    expect(result).toMatchObject({ healthy: true });
  });

  it('still pages a dry-run pipeline whose job has stopped', async () => {
    stateIs({ config: { ...CONFIG, dryRun: true }, lastRun: hoursBefore(79), lastRow: null });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, paged: 1 });
  });

  it('is gated on the SAME flag the producer is gated on', async () => {
    stateIs({ lastRun: hoursBefore(1), lastRow: hoursBefore(1) });

    await autoFeatureHealthCheckJob.run();

    // Pinned as a literal. Gate this on any other flag and the check goes silent while the producer
    // keeps running, or stays noisy while the producer is off — and every other assertion in this
    // file passes either way, because the mock ignores its argument.
    expect(mocks.isFlipt).toHaveBeenCalledWith('auto-feature-images');

    // Read from source, because the line above is otherwise a tautology: the string it compares
    // against comes from this file's own `vi.mock` of the flipt client, so renaming the REAL enum
    // value leaves it green while prod goes double-silent — the producer stops on a flag Flipt does
    // not know, and this check reports `skipped`. The KeyValue test above is sound for exactly this
    // reason; `importActual` is not an option here, it pulls `~/env/server`.
    const fliptClient = readFileSync(resolve(__dirname, '../../flipt/client.ts'), 'utf-8');
    expect(fliptClient).toMatch(/AUTO_FEATURE_IMAGES = 'auto-feature-images'/);

    // One side only is not enough — the same asymmetry the KeyValue-key test above closes. Gate the
    // PRODUCER on a different flag and this check goes silent while the job keeps running, or stays
    // noisy while it is off, with every assertion in this file still green.
    // First identifier only, same rationale as the getJobDate regex above: `isEnabled` takes
    // (flag, entityId?, context?), so giving the producer a segment rollout is behaviour-preserving
    // for WHICH flag it is, and anchoring on the closing paren would redden with a message saying
    // the producer is ungated when it is not.
    const producer = readFileSync(resolve(__dirname, '../auto-feature-images.ts'), 'utf-8');
    const gate = producer.match(/isFlipt\(\s*([A-Za-z_$][\w$.]*)/);
    expect(gate?.[1]).toBe('FLIPT_FEATURE_FLAGS.AUTO_FEATURE_IMAGES');
  });

  it('sends the page to the webhook, with the failure in the body', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });

    await autoFeatureHealthCheckJob.run();

    // `toHaveBeenCalledOnce` describes the harness; the thing that matters is the request. An empty
    // embed, a blank description, or a POST to the wrong host all satisfy a call-count assertion
    // identically, and all three deliver a page that tells nobody anything.
    const { url, init, body } = discordCall();
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(body.embeds[0].description).toContain('No completed run');
    expect(body.embeds[0].title).toContain('Auto-feature');
  });

  it('does not fetch at all when no webhook is configured', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });
    setEnv({ DISCORD_WEBHOOK_MOD_ALERTS: undefined });

    const result = await autoFeatureHealthCheckJob.run();

    // Every other test in this file sets the webhook, so the guard's absence is invisible to them —
    // deleting it would only show up in an environment that has no webhook, as `fetch(undefined)`.
    expect(mocks.fetch).not.toHaveBeenCalled();
    // The finding still has to survive to Axiom; only its delivery is missing.
    expect(result).toMatchObject({ healthy: false, alerts: 1, paged: 0 });
    // An environment with no webhook is not a broken alarm. Reporting it as a delivery failure
    // would fire this warning on every unhealthy run in dev and preview, which trains whoever
    // eventually sees the real one to ignore it.
    expect(axiom('warning').some((a) => a.message?.includes('Discord rejected'))).toBe(false);
    expect(axiom('info').some((a) => a.message?.includes('No DISCORD_WEBHOOK'))).toBe(true);
  });

  it('reports paged: 0 and warns when the webhook rejects the page', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 404 }));

    const result = await autoFeatureHealthCheckJob.run();

    // A revoked webhook must not leave the job claiming it alerted someone. This job exists to make
    // a silent failure visible; it must not have one of its own.
    expect(result).toMatchObject({ healthy: false, alerts: 1, paged: 0 });
    expect(axiom('warning').some((a) => a.message?.includes('Discord rejected'))).toBe(true);
  });

  it('still delivers a page after an earlier test stubbed a rejection', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });

    const result = await autoFeatureHealthCheckJob.run();

    // Position matters: this must run after the test that stubs a 404, and asserts the stub was
    // restored. `vi.clearAllMocks()` keeps implementations, so without the restore in `beforeEach`
    // that 404 leaks into every later test. Reordering the file, or any invocation that shuffles
    // test order, breaks it here rather than in a later test that would appear to break the code it
    // is testing.
    expect(result).toMatchObject({ healthy: false, paged: 1 });
    expect(axiom('warning').some((a) => a.message?.includes('Discord rejected'))).toBe(false);
  });

  it('does not blame the caps when the attribution account is missing', async () => {
    stateIs({ lastRun: hoursBefore(1), lastRow: null });
    dbMock.dbRead.user.findFirst.mockResolvedValue(null);

    const result = await autoFeatureHealthCheckJob.run();

    // lastRow is null because we could not look, not because the job wrote nothing. Reporting
    // "running but not writing" here names the caps for a fault that is a missing user account.
    expect(result).toMatchObject({ healthy: true });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('skips without paging when the auto-feature flag is off', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });
    mocks.isFlipt.mockResolvedValue(false);

    const result = await autoFeatureHealthCheckJob.run();

    // The flag off makes the producer return before it touches anything, by design.
    expect(result).toMatchObject({ skipped: true });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('still records the heartbeat age when the flag reads off', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });
    mocks.isFlipt.mockResolvedValue(false);

    const result = await autoFeatureHealthCheckJob.run();

    // `isFlipt` returns false for an unreachable Flipt too, so this path is also what a control-
    // plane outage looks like — and it stops the producer and this check together. A flag reading
    // off over a heartbeat that is 79h old is the only trace that case leaves.
    expect(result).toMatchObject({ lastRun: hoursBefore(79).toISOString() });
  });
});

describe('auto-feature-health-check heartbeat parsing', () => {
  it('treats a KeyValue row that is not a millisecond number as no heartbeat', async () => {
    // `KeyValue.value` is untyped Json and other keys in the table hold arrays and strings. Reading
    // one of those as epoch 0 rather than as null would page, which is the safe direction — but an
    // unparseable value must not become a plausible-looking date either.
    // `['1']` is here because `KeyValue` genuinely holds arrays for other keys and `Number(['1'])`
    // is 1 — the one shape that becomes a plausible-looking 1970 date rather than obviously junk.
    for (const value of [null, {}, 'not-a-date', 0, ['1']]) {
      vi.clearAllMocks();
      setEnv({ DISCORD_WEBHOOK_MOD_ALERTS: WEBHOOK });
      stateIs({ lastRun: NOW, lastRow: NOW });
      dbMock.dbRead.keyValue.findUnique.mockResolvedValue({
        key: AUTO_FEATURE_JOB_DATE_KEY,
        value,
      });

      const health = await readAutoFeatureHealth();

      expect(health.lastRun).toBeNull();
    }
  });

  it('accepts the millisecond number getJobDate actually writes', async () => {
    stateIs({ lastRun: NOW, lastRow: NOW });

    const health = await readAutoFeatureHealth();

    // Without this, the guard above could be satisfied by rejecting everything.
    expect(health.lastRun).toEqual(NOW);
  });
});

describe('evaluateAutoFeatureHealth boundary', () => {
  // `rowsReadable` is required by AutoFeatureHealth and was missing — nothing catches that, because
  // tsconfig excludes `__tests__`. Its absence made the record branch unreachable here, so `record`
  // severity had no boundary test at all.
  const base = { staleAfterHours: 13, dryRun: false, collectionId: 107, rowsReadable: true };

  it('is quiet at the threshold and fires one hour past it', () => {
    const at = evaluateAutoFeatureHealth(
      { ...base, lastRun: hoursBefore(13), lastRow: hoursBefore(13) },
      NOW
    );
    const past = evaluateAutoFeatureHealth(
      { ...base, lastRun: hoursBefore(14), lastRow: hoursBefore(14) },
      NOW
    );

    expect(at).toHaveLength(0);
    expect(past.map((a) => a.severity)).toEqual(['page']);
  });

  it('records, and does not page, when only the rows are stale', () => {
    // The record branch has its own boundary and nothing exercised it: the fixture used to omit
    // `rowsReadable`, so this arm was unreachable and `record` severity was covered only by the
    // coarse 40h case elsewhere.
    const at = evaluateAutoFeatureHealth(
      { ...base, lastRun: hoursBefore(1), lastRow: hoursBefore(13) },
      NOW
    );
    const past = evaluateAutoFeatureHealth(
      { ...base, lastRun: hoursBefore(1), lastRow: hoursBefore(14) },
      NOW
    );

    expect(at).toHaveLength(0);
    expect(past.map((a) => a.severity)).toEqual(['record']);
  });
});
