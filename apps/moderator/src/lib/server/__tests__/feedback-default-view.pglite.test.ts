import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  feedbackKysely,
  freshAppFeedbackDb,
  seedFeedback,
  seedUser,
} from './feedback-pglite.harness';

/**
 * App feedback is monitored on the main app's App review page, so this queue's no-area view and its
 * sidebar badge leave `app-block` out — while picking that area, or opening one report by id, still
 * reaches it. Every case seeds rows in the other areas too, so a filter that dropped everything (or
 * nothing) cannot pass.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const service = await import('../feedback.service');

let db: PGlite;
let ids: { bug: number; marketplace: number; app: number; appReviewed: number };

beforeEach(async () => {
  // The app-listing migration is applied so `app-block` rows sit in the table they will in production.
  db = await freshAppFeedbackDb();
  dbHandle.current = feedbackKysely(db);
  const userId = await seedUser(db, 'reporter');
  ids = {
    bug: await seedFeedback(db, { userId, area: 'site-bug-report' }),
    app: await seedFeedback(db, { userId, area: 'app-block' }),
    marketplace: await seedFeedback(db, { userId, area: 'apps-marketplace' }),
    appReviewed: await seedFeedback(db, { userId, area: 'app-block', status: 'reviewed' }),
  };
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const listedIds = async (input: Parameters<typeof service.getFeedbackList>[0]) =>
  (await service.getFeedbackList(input)).items.map((r) => r.id).sort((a, b) => a - b);

describe('the queue with no area selected', () => {
  it('lists every other area’s `new` rows and no app-block row', async () => {
    expect(await listedIds({ statuses: ['new'] })).toEqual([ids.bug, ids.marketplace]);
  });

  it('leaves app-block out at every status, not only `new`', async () => {
    expect(await listedIds({ statuses: [] })).toEqual([ids.bug, ids.marketplace]);
  });

  it('treats an empty-string area as no area', async () => {
    expect(await listedIds({ statuses: ['new'], area: '' })).toEqual([ids.bug, ids.marketplace]);
  });
});

describe('the queue with an area selected', () => {
  it('lists app-block rows when that area is picked', async () => {
    expect(await listedIds({ statuses: [], area: 'app-block' })).toEqual([
      ids.app,
      ids.appReviewed,
    ]);
  });

  it('leaves every other area’s filter as it was (control)', async () => {
    expect(await listedIds({ statuses: ['new'], area: 'site-bug-report' })).toEqual([ids.bug]);
  });
});

// Invariant guards: neither path is touched by the exclusion, and both must keep reaching these rows.
describe('the rest of the page still reaches app-block rows', () => {
  it('opens one by id', async () => {
    expect((await service.getFeedbackRow(ids.app))?.area).toBe('app-block');
  });

  it('offers app-block as an area option', async () => {
    expect(await service.getFeedbackAreas()).toContain('app-block');
  });
});

describe('countNewFeedback', () => {
  it('counts every other area’s `new` rows and no app-block row', async () => {
    expect(await service.countNewFeedback()).toBe(2);
  });

  it('ignores a further app-block row and counts a further counted-area row (control)', async () => {
    const userId = await seedUser(db, 'second');
    await seedFeedback(db, { userId, area: 'app-block' });
    expect(await service.countNewFeedback()).toBe(2);
    await seedFeedback(db, { userId, area: 'site-bug-report' });
    expect(await service.countNewFeedback()).toBe(3);
  });

  it('agrees with the length of the queue the badge links to', async () => {
    const { items } = await service.getFeedbackList({ statuses: ['new'] });
    expect(await service.countNewFeedback()).toBe(items.length);
  });
});
