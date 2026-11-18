/**
 * Contract tests for the external prompt-moderation metric family.
 *
 * The `source` label is CLOSED at runtime, not just in the type system. ⚠️ NOT because "an options
 * object built by spread can carry any string" — that rationale was fiction and is retracted in
 * full at `~/server/prom/external-moderation.metrics`: every production `auditPromptServer` call
 * site builds an inline object literal, so excess-property checking applies to all of them. The
 * real reason is that `moderatePrompt` is EXPORTED, so its second argument is reachable from
 * callers `tsc` does not constrain — a value already widened to `string` (a cast, a `JSON.parse`),
 * and the test tree, which `tsconfig.json` excludes. An unbounded label on a hot-path histogram is
 * a cardinality incident, not a cosmetic bug.
 *
 * Read against the REAL prom-client registry (`@civitai/telemetry/client` is not stubbed by
 * src/__tests__/setup.ts, which only replaces `~/server/prom/client`), so every assertion below is
 * about what is actually recorded on the registry /api/metrics scrapes — not about whether we
 * called our own wrapper.
 */
import promClient from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  isAbortDeadlineError,
  observeExternalModeration,
  recordExternalModerationSkipped,
} from '~/server/prom/external-moderation.metrics';

const HIST = 'civitai_app_external_moderation_duration_seconds';
const SKIPPED = 'civitai_app_external_moderation_skipped_total';

type Sample = { metricName?: string; labels: Record<string, string | number>; value: number };

async function samples(name: string): Promise<Sample[]> {
  const metric = promClient.register.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} is not registered`);
  return (await metric.get()).values as Sample[];
}

async function histCount(source: string, outcome: string) {
  const vals = await samples(HIST);
  return (
    vals.find(
      (v) =>
        v.metricName === `${HIST}_count` &&
        v.labels.source === source &&
        v.labels.outcome === outcome
    )?.value ?? 0
  );
}

async function skippedCount(source: string) {
  const vals = await samples(SKIPPED);
  return vals.find((v) => v.labels.source === source)?.value ?? 0;
}

beforeEach(() => {
  promClient.register.getSingleMetric(HIST)?.reset();
  promClient.register.getSingleMetric(SKIPPED)?.reset();
});

describe('isAbortDeadlineError', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'TimeoutError'],
  ])('returns false for %s rather than throwing', (_label, value) => {
    expect(isAbortDeadlineError(value)).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const e: { name: string; cause?: unknown } = { name: 'Error' };
    e.cause = e;
    expect(isAbortDeadlineError(e)).toBe(false);
  });
});

describe('observeExternalModeration', () => {
  it('clamps an out-of-vocabulary source at the recording site, not only at the call site', async () => {
    observeExternalModeration('nonsense' as never, 'ok', 0.2);

    expect(await histCount('other', 'ok')).toBe(1);
    expect(await histCount('nonsense', 'ok')).toBe(0);
  });

  it('never throws, so a metrics fault cannot fail a generation', () => {
    // A NaN duration is what prom-client rejects; the wrapper must swallow it.
    expect(() => observeExternalModeration('generate', 'ok', Number.NaN)).not.toThrow();
    expect(() => observeExternalModeration('generate', 'ok', 'x' as never)).not.toThrow();
  });
});

describe('recordExternalModerationSkipped', () => {
  it('clamps its source and never throws', async () => {
    expect(() => recordExternalModerationSkipped('nope' as never)).not.toThrow();
    expect(await skippedCount('other')).toBe(1);
  });
});
