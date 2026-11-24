import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { APPEAL_MEDIA_SCHEMA } from './appeal-media-schema';

/**
 * Pins the media access rule (`restrictedImageIds` in retracted-media.ts). A ruling on an image appeal from a ticket answers as the appeals queue does: refused for an image
 * the queue sends this moderator without media. The ticket's reads and the access rule run against
 * pglite; the help desk (which ticket links to whom, the note) is faked, and so is the ruling's
 * write, which a test only needs to see reached.
 */

vi.setConfig({ hookTimeout: 60_000 });

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
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { ticketAppealDeps } = await import('../tickets/appeal-actions');
const { createTicketAppealActions } = await import('../tickets/appeal-write');
const { applyGrants, SUPER_ROLE } = await import('../access');
const { APPEAL_RULING_REFUSED } = await import('$lib/held-media');

const OWNER = 7;
const WITHHELD = 301;
const APPEAL = 31;
const CLEAN = 990000030;
const CLEAN_APPEAL = 990000031;
const APPEALS_ROLE = 'appeals-reviewer';

const WITHOUT_GRANT = { id: 2, roles: [APPEALS_ROLE] };
const WITH_GRANT = { id: 3, roles: [SUPER_ROLE] };

const resolve = vi.fn(async () => ({ id: APPEAL }));
const actions = createTicketAppealActions({
  ...ticketAppealDeps,
  linkedUser: async () => ({ status: 'ok', userId: OWNER, ticketCreatedAt: null }),
  note: async () => ({ status: 'ok' } as never),
  resolve,
});

let db: PGlite;

beforeEach(async () => {
  resolve.mockClear();
  // The appeals page granted, the restricted review page not.
  applyGrants({ '/images/appeals': [APPEALS_ROLE] });
  db = await freshPglite();
  await db.exec(APPEAL_MEDIA_SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner');
    INSERT INTO "Image" (id, url, ingestion, "needsReview", "blockedFor", "userId") VALUES
      (${WITHHELD}, 'withheld-key', 'Blocked', 'appeal', 'CSAM', ${OWNER}),
      (${CLEAN}, 'clean-key', 'Scanned', 'appeal', NULL, ${OWNER});
    INSERT INTO "Appeal" (id, "userId", "entityType", "entityId") VALUES
      (${APPEAL}, ${OWNER}, 'Image', ${WITHHELD}),
      (${CLEAN_APPEAL}, ${OWNER}, 'Image', ${CLEAN});
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  applyGrants({});
  dbHandle.current = null;
  await db.close();
});

const rule = (
  user: { id: number; roles: string[] },
  status: 'Approved' | 'Rejected',
  appealId = APPEAL
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    ticketId: '5',
    userId: String(OWNER),
    appealId: String(appealId),
    status,
    resolvedReason: status === 'Approved' ? 'misclassified' : 'violation-confirmed',
  }))
    form.set(k, v);
  return actions.appealResolveImage({
    request: new Request('https://x.test/tickets/moderation', { method: 'POST', body: form }),
    locals: { user, grants: {} },
  } as never) as Promise<{ status?: number; data?: { error: string } }>;
};

describe('ticket appeal ruling on a withheld image', () => {
  it.each(['Approved', 'Rejected'] as const)(
    'refuses %s without the grant, and rules nothing',
    async (status) => {
      const result = await rule(WITHOUT_GRANT, status);

      expect(result).toMatchObject({ status: 403, data: { error: APPEAL_RULING_REFUSED } });
      expect(resolve).not.toHaveBeenCalled();
    }
  );

  it.each(['Approved', 'Rejected'] as const)('lets a grant holder rule %s', async (status) => {
    await rule(WITH_GRANT, status);

    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ imageId: WITHHELD, status })
    );
  });
});

// A gate that refused every ruling would pass the refusals above.
describe('ticket appeal ruling on an image nothing withholds', () => {
  it.each(['Approved', 'Rejected'] as const)('rules %s without the grant', async (status) => {
    await rule(WITHOUT_GRANT, status, CLEAN_APPEAL);

    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ imageId: CLEAN, status })
    );
  });
});
