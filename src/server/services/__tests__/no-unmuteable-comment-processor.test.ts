import { describe, expect, it } from 'vitest';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';

/**
 * Every notification processor that can emit for a `CommentV2` must carry the per-thread mute filter.
 *
 * Not a style rule: the comment family dedupes by `commentDedupeKey` and runs in priority batches, so
 * a processor that omits the filter does not merely leak its own notification — it CLAIMS the dedupe
 * key and replaces the higher-priority one that was correctly suppressed. Muting a thread would then
 * change which notification you get rather than silencing it.
 *
 * Asserted on the GENERATED SQL, like `notifications.block-filtering.test.ts` beside it, and for the
 * same reason: a processor appears here because it is a key on the real object, so one added in any
 * shape is covered. An earlier version of this guard parsed the source file with a regex and was
 * blind in three ways — a key line it failed to match merged that processor's body into the previous
 * one (which already had the filter), the literal text `notThreadMuted(` inside a SQL comment
 * satisfied it, and a recipient/author swap passed. All three are structural, none was a spelling
 * problem, and none is reachable from here.
 *
 * OUT OF SCOPE, deliberately, in both cases because there is nothing this mechanism could suppress:
 * legacy `Comment` (model-page discussion) rows have no `Thread`; and `new-comic-comment` is written
 * by `createNotification` from `comics.router.ts` rather than by a `prepareQuery`, so no producer-side
 * SQL filter reaches it at all. Its comments are always created in the chapter ROOT thread by that
 * same mutation, and no UI path mutes a root thread, so it has nothing to suppress today. Give comics
 * a reply path, or a way to mute a root thread, and it needs its own filter — this guard cannot see
 * that for you.
 */

type Def = { prepareQuery?: (args: { lastSent: string }) => string };

const defs = {
  ...(commentNotifications as unknown as Record<string, Def>),
  ...(mentionNotifications as unknown as Record<string, Def>),
};

const sqlFor = (type: string) => defs[type].prepareQuery?.({ lastSent: '2026-01-01' }) ?? '';

/**
 * Being named is not "somebody responded in a thread you're in" — Justin's call, 2026-08-27:
 * "direct mentions would be excluded from this". Safe against the batching rather than in spite of
 * it: Mention is priority 1, so a mention in a muted thread claims the dedupe key first and the
 * notifications the mute suppressed cannot re-emerge behind it.
 *
 * Adding `notThreadMuted` to `new-mention` REVERSES a product decision. It fails below rather than
 * passing quietly, which is the point of naming the exemption instead of leaving it as an absence.
 */
const MUTE_EXEMPT = new Set(['new-mention']);

// Matches the TABLE, not one spelling of the clause: `FROM "Thread" t JOIN "CommentV2" c`, or a line
// break after FROM, is the same processor and must not fall out of the sweep.
const v2Types = Object.keys(defs).filter((type) => sqlFor(type).includes('"CommentV2"'));
const filteredTypes = v2Types.filter((type) => !MUTE_EXEMPT.has(type));

/**
 * The recipient each processor already proved it knows, taken from its OWN block filter rather than
 * from a list maintained here. A hand-written table of expected recipients cannot catch a
 * hand-written mistake, and this is the same class of asymmetry: `notThreadMuted(<author>, ...)` is
 * valid SQL that suppresses nobody.
 *
 * Read by the clause carrying `type IN ('Block', 'Hide')`, which is the recipient's own direction.
 * `notBlockedBetween` emits BOTH directions, so matching `blk."userId" = X` positionally also picks
 * up the ACTOR from the second clause — which made the first version of this assertion accept a
 * deliberate recipient/author swap. Measured, not reasoned: that mutant passed 29/29 before this.
 */
const blockRecipients = (sql: string) =>
  [
    ...sql.matchAll(
      /blk\."userId" = (.+?) AND blk\."targetUserId" = .+? AND blk\.type IN \('Block', 'Hide'\)/g
    ),
  ].map((m) => m[1].trim());

const muteRecipients = (sql: string) =>
  [...sql.matchAll(/WHERE tm\."userId" = ([\s\S]+?)\n\s*\)/g)].map((m) => m[1].trim());

describe('comment notifications — per-thread mute', () => {
  // A name added here silently removes two tests per processor and the run stays green at 27, so the
  // exemption list is pinned as well as documented.
  it('exempts exactly one processor, on purpose', () => {
    expect([...MUTE_EXEMPT]).toEqual(['new-mention']);
    expect(filteredTypes).toHaveLength(13);
  });

  it('finds the family on the real objects', () => {
    // A sweep over an empty list passes vacuously.
    expect(v2Types.length).toBeGreaterThanOrEqual(14);
    expect(v2Types).toContain('new-image-comment');
    expect(v2Types).toContain('new-mention');
  });

  it.each(filteredTypes)('%s suppresses a muted thread', (type) => {
    const sql = sqlFor(type);
    expect(sql).toContain('"ThreadMute" tm');
    // The walk, not just the table: a join that never climbs would silence only the exact thread.
    expect(sql).toContain('WITH RECURSIVE muteable_threads');
    // Seeded from the comment's OWN thread alias. Passing `root.id` instead is valid SQL that starts
    // the walk at NULL for a top-level comment, so the filter matches nothing and suppression dies.
    expect(sql).toContain('SELECT t.id "id", 0 "depth"');
  });

  it.each(filteredTypes)('%s mutes for the RECIPIENT, not the comment author', (type) => {
    const sql = sqlFor(type);
    const expected = blockRecipients(sql);
    const actual = muteRecipients(sql);
    expect(expected.length).toBeGreaterThan(0);
    expect(actual.length).toBeGreaterThan(0);
    for (const recipient of actual) {
      expect(
        expected,
        `${type} mutes on ${recipient}, which is not the recipient its own block filter uses — a mute keyed on the comment author suppresses nobody`
      ).toContain(recipient);
    }
  });

  it('leaves direct mentions muteable ONLY through the global new-mention setting', () => {
    const sql = sqlFor('new-mention');
    expect(sql).toContain('FROM "CommentV2"');
    expect(sql).not.toContain('"ThreadMute"');
  });

  it('leaves the legacy Comment-only processors alone', () => {
    const legacy = Object.keys(defs).filter(
      (type) =>
        sqlFor(type).includes('FROM "Comment"') && !sqlFor(type).includes('FROM "CommentV2"')
    );
    expect(legacy.sort()).toEqual(
      ['new-comment', 'new-comment-nested', 'new-comment-response'].sort()
    );
    for (const type of legacy) expect(sqlFor(type)).not.toContain('"ThreadMute"');
  });
});
