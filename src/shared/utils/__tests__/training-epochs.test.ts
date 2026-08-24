import { describe, expect, it } from 'vitest';
import { epochsCompletedForRun, resolveEpochOffset } from '~/shared/utils/training-epochs';

describe('resolveEpochOffset', () => {
  it('takes the source epoch for a continuation', () => {
    expect(resolveEpochOffset(undefined, 10)).toBe(10);
  });

  it('is zero for a run that continues nothing', () => {
    expect(resolveEpochOffset(undefined, undefined)).toBe(0);
  });

  // A resubmit after a failed attempt must not re-derive: the stored value is what the already
  // ingested epochs were numbered with.
  it('keeps an offset already stamped on the run', () => {
    expect(resolveEpochOffset(10, 99)).toBe(10);
    expect(resolveEpochOffset(0, 99)).toBe(0);
  });

  // -1 is the "orchestrator never numbered this epoch" sentinel, and Train Further sends it back.
  it('clamps a negative or fractional source epoch', () => {
    expect(resolveEpochOffset(undefined, -1)).toBe(0);
    expect(resolveEpochOffset(undefined, 10.7)).toBe(10);
  });
});

describe('epochsCompletedForRun', () => {
  const numbered = (...ns: number[]) => ns.map((epochNumber) => ({ epochNumber }));

  it('reports progress in epochs, not saved checkpoints', () => {
    expect(epochsCompletedForRun({ epochs: numbered(1, 4, 7, 52) })).toBe(52);
  });

  it('subtracts the offset so a continuation is measured against its own configured epochs', () => {
    expect(epochsCompletedForRun({ epochs: numbered(11, 12, 15), epochOffset: 10 })).toBe(5);
  });

  it('is unchanged for a run with no offset', () => {
    expect(epochsCompletedForRun({ epochs: numbered(1, 2, 3) })).toBe(3);
  });

  it('does not depend on the array being sorted', () => {
    expect(epochsCompletedForRun({ epochs: numbered(15, 12, 11), epochOffset: 10 })).toBe(5);
  });

  it('reads the legacy v1 epoch shape', () => {
    expect(epochsCompletedForRun({ epochs: [{ epoch_number: 7 }, { epoch_number: 9 }] })).toBe(9);
  });

  it('is zero when there are no epochs, or none the orchestrator numbered', () => {
    expect(epochsCompletedForRun({ epochs: [] })).toBe(0);
    expect(epochsCompletedForRun({})).toBe(0);
    expect(epochsCompletedForRun({ epochs: numbered(-1) })).toBe(0);
  });
});
