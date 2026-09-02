import { describe, it, expect } from 'vitest';

import {
  filterModelsWithRecentActivity,
  ACTIVITY_WINDOW_DAYS,
  type ModelVersionActivityRow,
} from '~/server/jobs/remove-old-drafts';

/**
 * Behavioural coverage of the activity fence.
 *
 * The rule also exists as SQL in the job's replica SELECT, and that copy cannot
 * be exercised here — this repo has no DB-backed vitest project, so there is no
 * engine to run `NOT EXISTS` against. `remove-old-drafts.test.ts` pins the SQL's
 * text; these tests pin what the rule MEANS, on the copy that runs immediately
 * before the delete.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T00:00:00.000Z');
const daysBefore = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

// Both fixture ages are far off the 30-day boundary, on opposite sides: nothing
// sits at the cutoff, so no clause can be skipped by landing exactly on it, and
// a window widened to 300 days has a 200-day fixture to be caught by.
const QUIET_DAYS = 200;
const RECENT_DAYS = 5;
const quiet = daysBefore(QUIET_DAYS);
const recent = daysBefore(RECENT_DAYS);

function row(over: Partial<ModelVersionActivityRow> = {}): ModelVersionActivityRow {
  return { id: 100, modelId: 1, createdAt: quiet, updatedAt: quiet, latestFileAt: null, ...over };
}

const run = (rows: ModelVersionActivityRow[], candidates = [1]) =>
  filterModelsWithRecentActivity(candidates, rows, NOW);

describe('filterModelsWithRecentActivity', () => {
  // POSITIVE CONTROL. Every "spared" assertion below is satisfied by an empty
  // deletable list, so without this a fence that refuses everything — or a
  // harness wired to nothing — reads green across the whole file.
  it('lets a model through when every timestamp under it is long quiet', () => {
    expect(
      run([row()]),
      'the quiet baseline must be DELETABLE, or every "spares" case below passes vacuously'
    ).toEqual({ deletable: [1], skipped: [] });
  });

  it('keeps a candidate that has no versions at all', () => {
    expect(run([])).toEqual({ deletable: [1], skipped: [] });
  });

  it('spares a model whose version was CREATED inside the window', () => {
    expect(run([row({ createdAt: recent })]), 'clause: mv."createdAt" inside the window').toEqual({
      deletable: [],
      skipped: [1],
    });
  });

  it('spares a model whose version was UPDATED inside the window', () => {
    expect(run([row({ updatedAt: recent })]), 'clause: mv."updatedAt" inside the window').toEqual({
      deletable: [],
      skipped: [1],
    });
  });

  // The reported exhibit: the model and its only version were created in the
  // same minute and never touched again, and the trained resource arrived later
  // as a file. This is the only clause that can see it.
  it('spares a model whose FILE was created inside the window', () => {
    expect(
      run([row({ latestFileAt: recent })]),
      'clause: mf."createdAt" inside the window'
    ).toEqual({ deletable: [], skipped: [1] });
  });

  it('does not treat "no files" as activity', () => {
    expect(run([row({ latestFileAt: null })])).toEqual({ deletable: [1], skipped: [] });
  });

  it('spares a model when a REQUIRED timestamp is unreadable', () => {
    // createdAt / updatedAt are NOT NULL in the schema, so a missing value means
    // the query shape drifted. Deleting is irreversible; sparing costs a night.
    expect(
      run([row({ createdAt: null })]),
      'clause: unreadable required timestamp must fail CLOSED'
    ).toEqual({ deletable: [], skipped: [1] });
    expect(run([row({ updatedAt: 'not-a-date' })])).toEqual({ deletable: [], skipped: [1] });
    expect(run([row({ latestFileAt: 'not-a-date' })])).toEqual({ deletable: [], skipped: [1] });
  });

  it('spares the WHOLE candidate set when a row carries no usable modelId', () => {
    const orphan = { ...row(), modelId: undefined } as unknown as ModelVersionActivityRow;
    expect(
      run([orphan], [1, 2, 3]),
      'clause: unattributable activity must fail CLOSED across the batch, not protect nothing'
    ).toEqual({ deletable: [], skipped: [1, 2, 3] });
  });

  it('separates active from quiet models inside one candidate set', () => {
    const result = run(
      [
        row({ id: 10, modelId: 1, latestFileAt: recent }),
        row({ id: 20, modelId: 2 }),
        row({ id: 30, modelId: 3, createdAt: recent }),
        row({ id: 40, modelId: 4 }),
      ],
      [1, 2, 3, 4]
    );
    expect(result).toEqual({ deletable: [2, 4], skipped: [1, 3] });
  });

  it('protects a model when ANY of its versions is active', () => {
    const result = run(
      [row({ id: 10, modelId: 1 }), row({ id: 11, modelId: 1, updatedAt: recent })],
      [1]
    );
    expect(result).toEqual({ deletable: [], skipped: [1] });
  });

  it('preserves the candidate order the caller supplied', () => {
    // The SELECT orders by id for consistent lock ordering; the filter must not
    // reshuffle what it hands to the DELETE.
    expect(run([], [5, 1, 9])).toEqual({ deletable: [5, 1, 9], skipped: [] });
  });

  it('accepts the string timestamps a raw driver can hand back', () => {
    expect(run([row({ latestFileAt: recent.toISOString() })])).toEqual({
      deletable: [],
      skipped: [1],
    });
    expect(run([row({ createdAt: quiet.toISOString(), updatedAt: quiet.toISOString() })])).toEqual({
      deletable: [1],
      skipped: [],
    });
  });

  it('measures the window from the supplied clock, not the wall clock', () => {
    // A row one day inside the window is active; the same row is quiet once the
    // clock advances past it. This is what makes ACTIVITY_WINDOW_DAYS load-bearing
    // rather than decorative.
    const edgeIn = daysBefore(ACTIVITY_WINDOW_DAYS - 1);
    expect(filterModelsWithRecentActivity([1], [row({ updatedAt: edgeIn })], NOW)).toEqual({
      deletable: [],
      skipped: [1],
    });
    const later = new Date(NOW.getTime() + 2 * DAY_MS);
    expect(filterModelsWithRecentActivity([1], [row({ updatedAt: edgeIn })], later)).toEqual({
      deletable: [1],
      skipped: [],
    });
  });
});
