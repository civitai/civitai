import { describe, expect, it } from 'vitest';
import {
  MODEL_PERMISSION_LOG_START,
  mergePermissionAt,
  parseSourceModelId,
} from '../merge-permission';

const d = (iso: string) => new Date(iso);
const OLD_MODEL = d('2025-01-01T00:00:00Z');

describe('mergePermissionAt', () => {
  // Merges allowed until 1 Sep, then switched off: the case the feature exists for.
  const switchedOff = [
    { effectiveAt: MODEL_PERMISSION_LOG_START, allowDerivatives: true },
    { effectiveAt: d('2026-09-01T00:00:00Z'), allowDerivatives: false },
  ];
  const current = { allowDerivatives: false };

  it('judges a merge made before the switch by the permission then in effect', () => {
    expect(
      mergePermissionAt({
        at: d('2026-08-15T00:00:00Z'),
        snapshots: switchedOff,
        current,
        sourceCreatedAt: OLD_MODEL,
      })
    ).toMatchObject({ status: 'allowed' });
  });

  it('control: a merge made after the switch is not allowed', () => {
    expect(
      mergePermissionAt({
        at: d('2026-09-02T00:00:00Z'),
        snapshots: switchedOff,
        current,
        sourceCreatedAt: OLD_MODEL,
      })
    ).toMatchObject({ status: 'not-allowed' });
  });

  it('a change takes effect at its own instant', () => {
    expect(
      mergePermissionAt({
        at: d('2026-09-01T00:00:00Z'),
        snapshots: switchedOff,
        current,
        sourceCreatedAt: OLD_MODEL,
      })
    ).toMatchObject({ status: 'not-allowed' });
  });

  it('does not depend on the order snapshots arrive in', () => {
    expect(
      mergePermissionAt({
        at: d('2026-08-15T00:00:00Z'),
        snapshots: [...switchedOff].reverse(),
        current,
        sourceCreatedAt: OLD_MODEL,
      })
    ).toMatchObject({ status: 'allowed' });
  });

  it('never guesses before the log began', () => {
    expect(
      mergePermissionAt({
        at: d('2026-06-01T00:00:00Z'),
        snapshots: switchedOff,
        current,
        sourceCreatedAt: OLD_MODEL,
      })
    ).toEqual({ status: 'unknown', reason: 'before-log', knownSince: MODEL_PERMISSION_LOG_START });
  });

  it('with no snapshots, holds the current permission since the log began', () => {
    const args = { snapshots: [], current: { allowDerivatives: true }, sourceCreatedAt: OLD_MODEL };
    expect(mergePermissionAt({ ...args, at: d('2026-08-15T00:00:00Z') })).toMatchObject({
      status: 'allowed',
    });
    expect(mergePermissionAt({ ...args, at: d('2026-07-01T00:00:00Z') })).toMatchObject({
      status: 'unknown',
      reason: 'before-log',
    });
  });

  it('with no snapshots, a source created after the log began is known from its creation', () => {
    const created = d('2026-09-10T00:00:00Z');
    const args = { snapshots: [], current: { allowDerivatives: false }, sourceCreatedAt: created };
    expect(mergePermissionAt({ ...args, at: d('2026-09-11T00:00:00Z') })).toEqual({
      status: 'not-allowed',
      knownSince: created,
    });
    expect(mergePermissionAt({ ...args, at: d('2026-09-01T00:00:00Z') })).toMatchObject({
      status: 'unknown',
      reason: 'before-source-existed',
    });
  });
});

describe('parseSourceModelId', () => {
  it.each([
    ['123', 123],
    [' 123 ', 123],
    [123, 123],
    ['https://civitai.com/models/123', 123],
    ['https://civitai.com/models/123/some-lora?modelVersionId=456', 123],
    ['civitai.red/models/123#reviews', 123],
  ])('%s -> %s', (input, expected) => {
    expect(parseSourceModelId(input)).toBe(expected);
  });

  it.each([
    [''],
    ['abc'],
    ['0'],
    ['-5'],
    ['https://civitai.com/models/'],
    ['https://civitai.com/images/123'],
    ['https://civitai.com/models/123abc'],
    [1.5],
    [null],
  ])('rejects %s', (input) => {
    expect(parseSourceModelId(input)).toBeUndefined();
  });
});
