import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CSAM_ARCHIVE_OUTCOMES,
  CSAM_ARCHIVE_PATHS,
  CSAM_ARCHIVE_TYPES,
  REACHABLE_SERIES,
  csamArchivePathFor,
  ensureRegisterCsamArchiveMetrics,
  recordCsamArchive,
} from '../csam-archive.metrics';

/**
 * The REAL prom-client side of the CSAM archive-path signal.
 *
 * Three failure classes are pinned here that a service-level test structurally
 * cannot see:
 *
 *   1. A metric-name or label-name typo. That sails through every test that mocks
 *      this module and yields a dashboard/alert that silently never fires — the
 *      exact class this signal exists to prevent. So this file drives the real
 *      default registry.
 *   2. 🔴 A throw escaping into the CSAM archive path. This emits on a SUCCESSFUL
 *      archive of legally-mandated evidence, so an unguarded prom-client error
 *      would turn a completed archive into a failed one — observability causing
 *      the outage it watches for.
 *   3. 🔴 The path mapping drifting from the flag semantics. `path` must describe
 *      what the CODE did, not what the flag said: the flag governs only
 *      `archiveImages`/`archiveGeneratedImages`, so the other two report types
 *      must read `none` no matter how it is set.
 */

const NAME = 'civitai_csam_archive_total';

function freshRegistry() {
  const reg = new client.Registry();
  ensureRegisterCsamArchiveMetrics(reg);
  return reg;
}

async function seriesOf(reg: client.Registry) {
  const metric = (await reg.getMetricsAsJSON()).find((m) => m.name === NAME);
  if (!metric) throw new Error(`${NAME} is not registered`);
  // `values` is untyped in prom-client's JSON shape; narrow to what we assert on.
  return (metric as unknown as { values: Array<{ labels: Record<string, string>; value: number }> })
    .values;
}

describe('csamArchivePathFor', () => {
  it('maps the two flag-governed types to stream/disk by the flag', () => {
    expect(csamArchivePathFor('Image', true)).toBe('stream');
    expect(csamArchivePathFor('Image', false)).toBe('disk');
    expect(csamArchivePathFor('GeneratedImage', true)).toBe('stream');
    expect(csamArchivePathFor('GeneratedImage', false)).toBe('disk');
  });

  it('🔴 maps every other type to `none` REGARDLESS of the flag', () => {
    // The regression this pins: labelling a TrainingData report `stream` because
    // the flag happened to be on would make the counter a record of the FLAG
    // rather than of the code, which is the confusion it was added to end.
    for (const type of ['TrainingData', 'ExternalLink'] as const) {
      expect(csamArchivePathFor(type, true)).toBe('none');
      expect(csamArchivePathFor(type, false)).toBe('none');
    }
  });
});

describe('REACHABLE_SERIES', () => {
  it('holds exactly the 6 (path, type) pairs the code can produce', () => {
    expect(REACHABLE_SERIES).toHaveLength(6);
    const asKeys = REACHABLE_SERIES.map(({ path, type }) => `${type}:${path}`).sort();
    expect(asKeys).toEqual(
      [
        'Image:stream',
        'Image:disk',
        'GeneratedImage:stream',
        'GeneratedImage:disk',
        'TrainingData:none',
        'ExternalLink:none',
      ].sort()
    );
  });

  it('🔴 excludes every combination the code CANNOT produce', () => {
    // Seeding an impossible pair would put a permanent zero on screen that no code
    // path can ever move — which reads as "this never happens" when it means "this
    // cannot happen".
    const produced = new Set(REACHABLE_SERIES.map(({ path, type }) => `${type}:${path}`));
    const impossible = [
      'ExternalLink:stream',
      'ExternalLink:disk',
      'TrainingData:stream',
      'TrainingData:disk',
      'Image:none',
      'GeneratedImage:none',
    ];
    for (const combo of impossible) expect(produced.has(combo)).toBe(false);
    // The naive product is 3 x 4 = 12 pairs; exactly half are unreachable.
    expect(produced.size + impossible.length).toBe(
      CSAM_ARCHIVE_PATHS.length * CSAM_ARCHIVE_TYPES.length
    );
  });
});

describe('ensureRegisterCsamArchiveMetrics', () => {
  it('🔴 seeds all 12 reachable series at 0, so a rare event is distinguishable from an unwired instrument', async () => {
    const values = await seriesOf(freshRegistry());
    expect(values).toHaveLength(REACHABLE_SERIES.length * CSAM_ARCHIVE_OUTCOMES.length);
    expect(values).toHaveLength(12);
    expect(values.every((v) => v.value === 0)).toBe(true);
    for (const { path, type } of REACHABLE_SERIES) {
      for (const outcome of CSAM_ARCHIVE_OUTCOMES) {
        expect(
          values.some(
            (v) => v.labels.path === path && v.labels.type === type && v.labels.outcome === outcome
          )
        ).toBe(true);
      }
    }
  });

  it('is idempotent — re-registering neither throws nor resets a counted value', async () => {
    const reg = freshRegistry();
    const { csamArchiveTotal } = ensureRegisterCsamArchiveMetrics(reg);
    csamArchiveTotal.inc({ path: 'stream', type: 'Image', outcome: 'success' });

    ensureRegisterCsamArchiveMetrics(reg);
    ensureRegisterCsamArchiveMetrics(reg);

    const v = (await seriesOf(reg)).find(
      (x) =>
        x.labels.path === 'stream' && x.labels.type === 'Image' && x.labels.outcome === 'success'
    );
    expect(v?.value).toBe(1);
    // Still 12 — a second registration must not duplicate the series.
    expect(await seriesOf(reg)).toHaveLength(12);
  });
});

describe('recordCsamArchive', () => {
  beforeEach(() => {
    client.register.removeSingleMetric(NAME);
  });

  it('increments exactly the addressed series on the default registry', async () => {
    recordCsamArchive('stream', 'Image', 'success');
    recordCsamArchive('stream', 'Image', 'success');
    recordCsamArchive('disk', 'GeneratedImage', 'error');

    const values = await seriesOf(client.register);
    const at = (path: string, type: string, outcome: string) =>
      values.find(
        (v) => v.labels.path === path && v.labels.type === type && v.labels.outcome === outcome
      )?.value;

    expect(at('stream', 'Image', 'success')).toBe(2);
    expect(at('disk', 'GeneratedImage', 'error')).toBe(1);
    // Everything else stays an observable 0 rather than vanishing.
    expect(at('stream', 'Image', 'error')).toBe(0);
    expect(at('none', 'TrainingData', 'success')).toBe(0);
  });

  it('🔴 DROPS an unknown label value rather than passing it through', async () => {
    // The 12-series cardinality claim rests on this, not on the erased types: this
    // runs on the jobs pool, where prom-client retains every distinct label set in
    // the Node heap for the process lifetime.
    // Seed first, exactly as /api/metrics does on every scrape. Without this the
    // counter would not be registered at all here — the validity guard returns
    // BEFORE `ensureRegister…`, so a run in which every call is dropped never
    // creates the metric. That is correct behaviour, but it is not the production
    // shape, and asserting against it would test the wrong thing.
    ensureRegisterCsamArchiveMetrics();

    recordCsamArchive('nonsense' as never, 'Image', 'success');
    recordCsamArchive('stream', 'NotAType' as never, 'success');
    recordCsamArchive('stream', 'Image', 'maybe' as never);

    const values = await seriesOf(client.register);
    expect(values).toHaveLength(12);
    expect(values.every((v) => v.value === 0)).toBe(true);
  });

  it('🔴 is FAIL-SOFT — a poisoned registration cannot throw into the archive path', () => {
    // Register the same name with a DIFFERENT labelset, which is what makes the
    // unchecked `as` cast inside the module dangerous: `inc` on a mismatched
    // labelset throws. The archive must survive it.
    client.register.removeSingleMetric(NAME);
    new client.Counter({
      name: NAME,
      help: 'poisoned: wrong labelset',
      labelNames: ['totally', 'different'] as const,
      registers: [client.register],
    });

    expect(() => recordCsamArchive('stream', 'Image', 'success')).not.toThrow();
  });
});
