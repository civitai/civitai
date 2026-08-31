import { describe, it, expect } from 'vitest';
import {
  reconcileWinnerToPersisted,
  type PersistedChallengeWinner,
} from '~/server/games/daily-challenge/challenge-winner-reconcile';

const entry = {
  userId: 100,
  imageId: 1,
  position: 1,
  prize: 500,
  reason: 'best',
};

const persisted = (over: Partial<PersistedChallengeWinner> = {}): PersistedChallengeWinner => ({
  id: 5,
  place: 1,
  buzzAwarded: 500,
  pointsAwarded: 10,
  created: false,
  ...over,
});

describe('reconcileWinnerToPersisted', () => {
  it('leaves a freshly inserted winner untouched', () => {
    expect(reconcileWinnerToPersisted(entry, persisted({ place: 9, created: true }))).toEqual(
      entry
    );
  });

  it('leaves the entry untouched when there is no persisted row', () => {
    expect(reconcileWinnerToPersisted(entry, null)).toEqual(entry);
  });

  it('leaves the entry untouched when the stored row already agrees', () => {
    expect(reconcileWinnerToPersisted(entry, persisted())).toEqual(entry);
  });

  it('adopts the stored place when it differs from the picked one', () => {
    expect(reconcileWinnerToPersisted(entry, persisted({ place: 2, buzzAwarded: 250 }))).toEqual({
      ...entry,
      position: 2,
      prize: 250,
    });
  });

  it('adopts the stored prize even when the place matches', () => {
    expect(reconcileWinnerToPersisted(entry, persisted({ buzzAwarded: 400 }))).toEqual({
      ...entry,
      prize: 400,
    });
  });

  it('does not mutate the input entry', () => {
    const input = { ...entry };
    reconcileWinnerToPersisted(input, persisted({ place: 3, buzzAwarded: 100 }));
    expect(input).toEqual(entry);
  });

  it('keeps the picked entry when the stored place is not a real number', () => {
    // Money path: an absent/garbled field must never propagate `undefined` into the payout amount
    // or the place-bearing transaction id.
    expect(
      reconcileWinnerToPersisted(entry, {
        place: undefined,
        buzzAwarded: undefined,
      } as unknown as PersistedChallengeWinner)
    ).toEqual(entry);
    expect(reconcileWinnerToPersisted(entry, persisted({ place: NaN, buzzAwarded: NaN }))).toEqual(
      entry
    );
  });

  it('keeps the picked entry when only the stored prize is unusable', () => {
    expect(
      reconcileWinnerToPersisted(
        entry,
        persisted({ place: 2, buzzAwarded: undefined as unknown as number })
      )
    ).toEqual(entry);
  });

  it('preserves extra fields on the entry', () => {
    const extended = { ...entry, imageId: 42, reason: 'x' as string | null };
    expect(reconcileWinnerToPersisted(extended, persisted({ place: 2, buzzAwarded: 250 }))).toEqual(
      {
        ...extended,
        position: 2,
        prize: 250,
      }
    );
  });
});
