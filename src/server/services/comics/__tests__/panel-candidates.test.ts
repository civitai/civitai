import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  planCandidateSlots,
  respondedCandidate,
  retainedCandidateKeys,
  selectableKeys,
  stricterLevel,
} from '~/server/services/comics/panel-candidates';

const out = (id: string, extra: { blockedReason?: string; url?: string | null } = {}) => ({
  id,
  url: `https://orchestrator.example/${id}`,
  ...extra,
});

describe('planCandidateSlots', () => {
  it('locks an output that now carries a block, keeping the stored key beside the lock', () => {
    const plans = planCandidateSlots(
      [out('a', { blockedReason: 'minor' })],
      [{ key: 'old-a', nsfwLevel: NsfwLevel.PG, outputId: 'a' }],
      [NsfwLevel.PG]
    );
    expect(plans).toEqual([
      {
        kind: 'locked',
        entry: {
          requiresUnlock: true,
          blockedReason: 'minor',
          nsfwLevel: NsfwLevel.PG,
          outputId: 'a',
          key: 'old-a',
        },
      },
    ]);
  });

  it('reuses a stored key from the entry with the same output id, whatever the order', () => {
    const plans = planCandidateSlots(
      [out('b'), out('a')],
      [
        { key: 'key-a', nsfwLevel: 1, outputId: 'a' },
        { key: 'key-b', nsfwLevel: 1, outputId: 'b' },
      ],
      [1, 1]
    );
    expect(plans.map((p) => p.kind === 'reuse' && p.entry.key)).toEqual(['key-b', 'key-a']);
  });

  it('downloads an output no stored entry names', () => {
    const plans = planCandidateSlots([out('c')], [{ key: 'key-a', outputId: 'a' }], [1]);
    expect(plans).toEqual([{ kind: 'download', outputId: 'c', nsfwLevel: 1 }]);
  });

  it('reuses older entries by position when the batch matches and nothing is blocked', () => {
    const plans = planCandidateSlots([out('a'), out('b')], ['key-0', { key: 'key-1' }], [1, 1]);
    expect(plans.map((p) => p.kind === 'reuse' && p.entry)).toEqual([
      { key: 'key-0', nsfwLevel: 1, outputId: 'a' },
      { key: 'key-1', nsfwLevel: 1, outputId: 'b' },
    ]);
  });

  it('locks every older keyed entry when any output in the batch is blocked', () => {
    const plans = planCandidateSlots(
      [out('a'), out('b', { blockedReason: 'canUpgrade' })],
      ['key-0', 'key-1'],
      [1, 1]
    );
    expect(plans.map((p) => p.kind)).toEqual(['locked', 'locked']);
    expect(plans.map((p) => p.kind === 'locked' && p.entry.key)).toEqual([undefined, undefined]);
  });

  const storedFrom = (plans: ReturnType<typeof planCandidateSlots>) =>
    plans.flatMap((p) => (p.kind === 'locked' || p.kind === 'reuse' ? [p.entry] : []));

  it('downloads fresh on the next run after a blocked output locked an older key', () => {
    const first = planCandidateSlots([out('a', { blockedReason: 'canUpgrade' })], ['key-0'], [1]);
    expect(first[0].kind === 'locked' && first[0].entry.key).toBeUndefined();
    expect(retainedCandidateKeys(['key-0'], storedFrom(first), [])).toEqual(['key-0']);
    const second = planCandidateSlots([out('a')], storedFrom(first), [1]);
    expect(second.map((p) => p.kind)).toEqual(['download']);
  });

  it('downloads fresh on the next run after a length mismatch locked an older key', () => {
    const first = planCandidateSlots([out('a'), out('b')], ['key-0'], [1, 1]);
    expect(first[0].kind === 'locked' && first[0].entry.key).toBeUndefined();
    expect(retainedCandidateKeys(['key-0'], storedFrom(first), [])).toEqual(['key-0']);
    const second = planCandidateSlots([out('a'), out('b')], storedFrom(first), [1, 1]);
    expect(second.map((p) => p.kind)).toEqual(['download', 'download']);
  });

  it('locks every older keyed entry when the batch length differs', () => {
    const plans = planCandidateSlots([out('a'), out('b')], ['key-0'], [1, 1]);
    expect(plans.map((p) => p.kind)).toEqual(['locked', 'download']);
  });

  it('gives a reused key the stricter of the stored and fresh level', () => {
    const [up] = planCandidateSlots([out('a')], [{ key: 'k', nsfwLevel: 1, outputId: 'a' }], [4]);
    const [down] = planCandidateSlots([out('a')], [{ key: 'k', nsfwLevel: 4, outputId: 'a' }], [1]);
    expect(up.kind === 'reuse' && up.entry.nsfwLevel).toBe(4);
    expect(down.kind === 'reuse' && down.entry.nsfwLevel).toBe(4);
  });

  it('brings back the kept key of a locked entry with the same output id once unblocked', () => {
    const [plan] = planCandidateSlots(
      [out('a')],
      [{ requiresUnlock: true, blockedReason: 'canUpgrade', key: 'kept', outputId: 'a' }],
      [1]
    );
    expect(plan).toEqual({ kind: 'reuse', entry: { key: 'kept', nsfwLevel: 1, outputId: 'a' } });
  });

  it('does not bring back the kept key of an older locked entry', () => {
    const [plan] = planCandidateSlots(
      [out('a')],
      [{ requiresUnlock: true, blockedReason: 'canUpgrade', key: 'kept' }],
      [1]
    );
    expect(plan.kind).toBe('download');
  });

  it('reports an output with no url as missing', () => {
    expect(planCandidateSlots([out('a', { url: null })], [], [null])[0].kind).toBe('missing');
  });
});

describe('stricterLevel', () => {
  it.each([
    [undefined, undefined, undefined],
    [undefined, 4, 4],
    [4, null, 4],
    [1, 8, 8],
    [8, 1, 8],
  ])('stored %s and fresh %s give %s', (stored, fresh, expected) => {
    expect(stricterLevel(stored, fresh)).toBe(expected);
  });
});

describe('candidate responses', () => {
  const locked = {
    requiresUnlock: true as const,
    blockedReason: 'canUpgrade',
    key: 'kept',
    nsfwLevel: 1,
  };

  it('never returns or offers the key a locked entry keeps', () => {
    expect(respondedCandidate(locked, 'blur', false)).toEqual({
      requiresUnlock: true,
      blockedReason: 'canUpgrade',
      blurredPreviewUrl: 'blur',
      nsfwLevel: 1,
    });
    expect(selectableKeys([locked], false)).toEqual([]);
  });

  it('withholds a key on the green site unless its level is rated safe', () => {
    const entries = [
      { key: 'safe', nsfwLevel: NsfwLevel.PG },
      { key: 'mature', nsfwLevel: NsfwLevel.R },
      { key: 'unknown' },
    ];
    expect(entries.map((e) => respondedCandidate(e, null, true))).toEqual([
      { key: 'safe', nsfwLevel: NsfwLevel.PG },
      {
        requiresUnlock: true,
        blockedReason: 'siteRestricted',
        blurredPreviewUrl: null,
        nsfwLevel: NsfwLevel.R,
      },
      {
        requiresUnlock: true,
        blockedReason: 'siteRestricted',
        blurredPreviewUrl: null,
        nsfwLevel: null,
      },
    ]);
    expect(selectableKeys(entries, true)).toEqual(['safe']);
    expect(selectableKeys(entries, false)).toEqual(['safe', 'mature', 'unknown']);
  });
});

describe('retainedCandidateKeys', () => {
  it('keeps every stored key the new set no longer holds, with those already retained', () => {
    expect(
      retainedCandidateKeys(
        ['old-0', { key: 'same' }, { requiresUnlock: true, blockedReason: 'x', key: 'kept' }],
        [{ key: 'same' }, { key: 'new' }],
        ['earlier']
      )
    ).toEqual(['earlier', 'old-0', 'kept']);
  });

  it('keeps nothing when every stored key is still held', () => {
    expect(retainedCandidateKeys([{ key: 'a' }], [{ key: 'a' }], undefined)).toEqual([]);
  });
});
