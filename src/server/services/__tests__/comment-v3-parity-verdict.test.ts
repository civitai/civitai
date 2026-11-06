import { describe, expect, it } from 'vitest';
import type { parityReport, unmirroredReport } from '~/server/services/comment-v3-backfill.service';
import { parityVerdict } from '~/server/services/comment-v3-backfill.service';

type Unmirrored = Awaited<ReturnType<typeof unmirroredReport>>;
type Parity = Awaited<ReturnType<typeof parityReport>>;

const zero = { count: 0, sample: [] as number[] };
const unmirroredKeys: (keyof Unmirrored)[] = [
  'v2_pending',
  'v2_no_thread',
  'v2_dead_parent',
  'v2_unresolved_entity',
  'v2_no_topic',
  'v2_pending_unexplained',
  'v1_pending',
  'v1_dead_parent',
  'v1_no_topic',
  'v1_pending_unexplained',
  'v2_reactions_pending',
  'v1_reactions_pending',
  'v2_reports_pending',
  'v1_reports_pending',
  'mutes_pending',
];
const parityKeys: (keyof Parity)[] = [
  'v2_ghosts',
  'v1_ghosts',
  'resurrected',
  'tombstones_childless',
  'thread_count_mismatch',
  'model_v1_count_mismatch',
  'topic_count_mismatch',
  'reaction_count_mismatch',
  'v2_reactions_extra',
  'v1_reactions_extra',
  'reports_extra',
  'topic_lock_mismatch',
  'comment_lock_mismatch',
  'v2_column_drift',
  'v1_column_drift',
  'v1_parent_mismatch',
  'mutes_extra',
  'topic_mutes_orphaned',
];
const unmirrored = (over: Partial<Unmirrored> = {}): Unmirrored =>
  ({ ...Object.fromEntries(unmirroredKeys.map((k) => [k, zero])), ...over } as Unmirrored);
const parity = (over: Partial<Parity> = {}): Parity =>
  ({ ...Object.fromEntries(parityKeys.map((k) => [k, zero])), ...over } as Parity);

const RESIDUE = [
  'v2_pending',
  'v2_no_thread',
  'v2_dead_parent',
  'v2_unresolved_entity',
  'v2_no_topic',
  'v1_pending',
  'v1_dead_parent',
  'v1_no_topic',
  'tombstones_childless',
  'topic_mutes_orphaned',
];

describe('parityVerdict', () => {
  it('is quiet when every finding is zero', () => {
    expect(parityVerdict(unmirrored(), parity())).toEqual({ pages: [], expected: [] });
  });

  it('treats pending rows as expected only up to the sum of the skipped classes', () => {
    // Distinct magnitudes, so a term dropped from the sum shows.
    const v = parityVerdict(
      unmirrored({
        v2_pending: { count: 1111, sample: [1] },
        v2_no_thread: { count: 1000, sample: [2] },
        v2_dead_parent: { count: 100, sample: [3] },
        v2_unresolved_entity: { count: 10, sample: [4] },
        v2_no_topic: { count: 1, sample: [5] },
        v1_pending: { count: 11, sample: [6] },
        v1_dead_parent: { count: 10, sample: [7] },
        v1_no_topic: { count: 1, sample: [8] },
      }),
      parity({
        tombstones_childless: { count: 1, sample: [9] },
        topic_mutes_orphaned: { count: 1, sample: [10] },
      })
    );
    expect(v.pages).toEqual([]);
    expect(v.expected).toEqual([
      'v2_pending: 1111 (e.g. 1)',
      'v2_no_thread: 1000 (e.g. 2)',
      'v2_dead_parent: 100 (e.g. 3)',
      'v2_unresolved_entity: 10 (e.g. 4)',
      'v2_no_topic: 1 (e.g. 5)',
      'v1_pending: 11 (e.g. 6)',
      'v1_dead_parent: 10 (e.g. 7)',
      'v1_no_topic: 1 (e.g. 8)',
      'tombstones_childless: 1 (e.g. 9)',
      'topic_mutes_orphaned: 1 (e.g. 10)',
    ]);
  });

  it('pages the unexplained pending rows with their own sample, not the skipped classes', () => {
    const v = parityVerdict(
      unmirrored({
        v2_pending: { count: 5, sample: [1, 2] },
        v2_no_thread: { count: 3, sample: [1] },
        v2_pending_unexplained: { count: 2, sample: [7, 8] },
        v1_pending: { count: 5, sample: [20] },
        v1_dead_parent: { count: 2, sample: [20] },
        v1_no_topic: { count: 1, sample: [21] },
        v1_pending_unexplained: { count: 2, sample: [30, 31] },
      }),
      parity()
    );
    expect(v.pages).toEqual([
      'v2_pending_unexplained: 2 (e.g. 7, 8)',
      'v1_pending_unexplained: 2 (e.g. 30, 31)',
    ]);
  });

  it('pages on every finding outside the residue set, with its sample', () => {
    for (const key of [...unmirroredKeys, ...parityKeys]) {
      const f = { count: 1, sample: [42] };
      const v = parityVerdict(
        unmirrored(unmirroredKeys.includes(key as keyof Unmirrored) ? { [key]: f } : {}),
        parity(parityKeys.includes(key as keyof Parity) ? { [key]: f } : {})
      );
      const line = `${key}: 1 (e.g. 42)`;
      if (RESIDUE.includes(key)) {
        expect(v, key).toEqual({ pages: [], expected: [line] });
      } else {
        expect(v, key).toEqual({ pages: [line], expected: [] });
      }
    }
  });
});
