import { describe, expect, it } from 'vitest';
import { placementNotifications } from '~/server/notifications/placement.notifications';

/**
 * What a placer is told once someone acts on their placement.
 *
 * Approval only, on both surfaces, plus the owner-removal the remix type
 * already had. These assert the SQL as text — the queries are built as strings
 * and never parsed in a unit run — so what they can catch is the scope of each
 * processor, which is exactly what changed here and exactly what is invisible
 * in production when it is wrong.
 */
type Def = (typeof placementNotifications)['sticker-placement-pending'];
const defs = placementNotifications as Record<string, Def>;

const LAST_SENT = '2026-08-16 00:00:00';
const query = async (type: string) =>
  (await defs[type].prepareQuery!({
    lastSent: LAST_SENT,
    lastSentDate: new Date(0),
    clickhouse: undefined,
  })) as string;

/**
 * Every placement status the query can select, read back out of the SQL.
 *
 * A set comparison rather than a pair of contains/not-contains assertions: it
 * fails with both sides printed, so putting `declined` back reads as
 * `'approved,declined' to be 'approved'` rather than as an anonymous false. It
 * also cannot pass by the processor having stopped selecting anything at all —
 * an empty set fails against a non-empty expectation, which is the failure mode
 * a bare "declined is absent" assertion would sail through.
 *
 * Comments are stripped first: these queries carry a lot of prose, and a status
 * named in one would otherwise read as a status selected.
 */
const statusesSelectedBy = (sql: string) =>
  [
    ...new Set(
      [
        ...sql.replace(/--[^\n]*/g, '').matchAll(/'(pending|approved|declined|expired|removed)'/g),
      ].map((m) => m[1])
    ),
  ]
    .sort()
    .join(',');

describe('the sticker placer hears about an acceptance', () => {
  it('is registered, toggleable, and not opt-in', () => {
    const def = defs['sticker-placement-resolved'];

    expect(def).toBeTruthy();
    expect(def.category).toBe('Creator');
    // `optIn` inverts what a settings row MEANS, and may only be set by a
    // processor that derives recipients by joining that table. This one excludes
    // with NOT EXISTS, so opting in here would ship it on while the UI drew it off.
    expect(def.optIn).toBeUndefined();
  });

  it('names the owner and links to the image', () => {
    const message = defs['sticker-placement-resolved'].prepareMessage({
      type: 'sticker-placement-resolved',
      details: { imageId: 74, ownerUsername: 'somebody', status: 'approved' },
    } as Parameters<Def['prepareMessage']>[0])!;

    expect(message.message).toBe('somebody accepted your sticker');
    expect(message.url).toBe('/images/74');
  });

  it('selects approvals and nothing else', async () => {
    expect(statusesSelectedBy(await query('sticker-placement-resolved'))).toBe('approved');
  });

  it('reads the moment the owner acted, not the moment the placement was made', async () => {
    const sql = await query('sticker-placement-resolved');

    // A placement made before the last run and accepted after it is missed
    // entirely by a createdAt window — the failure is a notification that never
    // arrives for exactly the placements that waited longest.
    expect(sql).toContain('p."resolvedAt" > \'2026-08-16 00:00:00\'');
    expect(sql).not.toContain('p."createdAt" >');
  });

  it('carries the status in the dedupe key', async () => {
    // Keying on the id alone means a later branch — a removal, say — collides
    // with the approval's key and is deduped away in silence.
    expect(await query('sticker-placement-resolved')).toContain(
      'CONCAT(\'sticker-placement-resolved:\',"status",\':\',"placementId")'
    );
  });

  it('covers free placements as well as paid', async () => {
    // The pending pair splits on `free` because their messages quote an amount.
    // This one names none, so one type serves both — and a `free` clause here
    // would silence exactly the tier that ships at daily volume.
    expect(await query('sticker-placement-resolved')).not.toMatch(/p\.free/);
  });
});

describe('the remix type stops announcing declines', () => {
  /**
   * Both halves in one run, deliberately. "Declines produce nothing" also passes
   * when the processor produces nothing at all, so the approval assertion beside
   * it is what makes this legible on revert rather than merely green.
   */
  it('selects approvals and owner-removals, not declines', async () => {
    const sql = await query('remix-gallery-resolved');

    expect(statusesSelectedBy(sql)).toBe('approved,removed');
    // The removal half is scoped to the owner's own action: a moderator takedown
    // is not something to announce to the person it was taken from.
    expect(sql).toContain('p."removedBy" = \'owner\'');
  });

  it('still renders a decline that was already delivered', () => {
    // The message is built at READ time from stored details, so the rows sent
    // before this change would blank out if the branch were deleted with the
    // query clause.
    const message = defs['remix-gallery-resolved'].prepareMessage({
      type: 'remix-gallery-resolved',
      details: { imageId: 7, ownerUsername: 'somebody', status: 'declined' },
    } as Parameters<Def['prepareMessage']>[0])!;

    expect(message.message).toBe('somebody declined your remix submission');
  });
});

describe('both resolved types honour their own setting', () => {
  // There is no global opt-out filter on this path — createNotificationsBulk
  // does no settings lookup — so a processor that omits this clause cannot be
  // muted at all, however its toggle renders.
  it.each(['sticker-placement-resolved', 'remix-gallery-resolved'])('%s', async (type) => {
    expect(await query(type)).toContain(
      `WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = '${type}')`
    );
  });
});
