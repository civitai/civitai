import { describe, expect, it } from 'vitest';
import { compare } from '../text-scan-lab/compare';
import type { LabScanResult } from '../text-scan-lab/types';

const scanned = (output: Record<string, unknown> | null, extra = {}): LabScanResult => ({
  key: 'k',
  ok: true,
  workflowId: 'wf',
  promptIds: {},
  output,
  elapsedMs: 1,
  ...extra,
});
const failed = (error: string): LabScanResult => ({ key: 'k', ok: false, error });

describe('compare', () => {
  it('marks an nsfw level that differs', () => {
    const rows = compare(
      scanned({ nsfw: { level: 'r', reason: 'x' } }),
      scanned({ nsfw: { level: 'pg13', reason: 'y' } }),
      ['nsfw']
    );
    expect(rows).toEqual([{ label: 'nsfw', a: 'r', b: 'pg13', differs: true }]);
  });

  it('does not mark the same level, whatever the reasons say', () => {
    const rows = compare(
      scanned({ nsfw: { level: 'x', reason: 'one' } }),
      scanned({ nsfw: { level: 'x', reason: 'two' } }),
      ['nsfw']
    );
    expect(rows[0]).toMatchObject({ a: 'x', b: 'x', differs: false });
  });

  it('compares flags on detected, one row per requested label', () => {
    const rows = compare(
      scanned({
        poi: { detected: true, names: ['Someone'], reason: '' },
        minor: { detected: false, reason: '' },
      }),
      scanned({
        poi: { detected: true, names: ['Other'], reason: '' },
        minor: { detected: true, reason: '' },
      }),
      ['poi', 'minor']
    );
    expect(rows).toEqual([
      { label: 'poi', a: 'yes (Someone)', b: 'yes (Other)', differs: false },
      { label: 'minor', a: 'no', b: 'yes', differs: true },
    ]);
  });

  it('shows the error on the failed side and counts it as a difference', () => {
    const rows = compare(
      failed('orchestrator said no'),
      scanned({ scam: { detected: false, reason: '' } }),
      ['scam']
    );
    expect(rows).toEqual([
      { label: 'scam', a: 'error: orchestrator said no', b: 'no', differs: true },
    ]);
  });

  it('shows a parse failure and a missing label, neither of them a verdict', () => {
    const rows = compare(scanned(null, { parseError: 'invalid-json' }), scanned({}), ['scam']);
    expect(rows).toEqual([
      { label: 'scam', a: 'unparsed: invalid-json', b: 'missing', differs: false },
    ]);
  });

  it('does not mark two failures as a difference', () => {
    const rows = compare(failed('a'), failed('b'), ['nsfw']);
    expect(rows[0]).toMatchObject({ a: 'error: a', b: 'error: b', differs: false });
  });
});
