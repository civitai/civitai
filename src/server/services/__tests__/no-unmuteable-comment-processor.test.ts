import { describe, expect, it } from 'vitest';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';

/**
 * Every notification processor that can emit for a comment must carry the mute filter (`notCommentMuted`).
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
 * OUT OF SCOPE, deliberately:
 * - the model-page discussion (`MODEL_ONLY` below): no mute control on its page. A model
 *   `CommentTopicMute` mirrored from a v2 section mute reaches `new-thread-response` but not these
 *   three; accepted until the model surface flips.
 * - `new-comic-comment`: written by `createNotification` in `comics.router.ts`, not a
 *   `prepareQuery`, so no SQL filter reaches it. Its comments are always chapter roots and no UI
 *   mutes a root. Give comics a reply path or a root mute and it needs its own filter; this guard
 *   cannot see that.
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
 * Adding `notCommentMuted` to `new-mention` REVERSES a product decision. It fails below rather than
 * passing quietly, which is the point of naming the exemption instead of leaving it as an absence.
 */
const MUTE_EXEMPT = new Set(['new-mention']);

/**
 * The model-page discussion: v1-shaped, with no mute control in its UI. Pinned by name below, so a
 * processor that moves to the thread-addressed shape has to leave this list and gain the filter.
 */
const MODEL_ONLY = new Set(['new-comment', 'new-comment-response', 'new-comment-nested']);

// Matches the TABLE, not one spelling of the clause: a line break after FROM is the same processor
// and must not fall out of the sweep.
const commentTypes = Object.keys(defs).filter((type) => sqlFor(type).includes('"CommentV3"'));
const filteredTypes = commentTypes.filter(
  (type) => !MUTE_EXEMPT.has(type) && !MODEL_ONLY.has(type)
);

/**
 * The recipient each processor already proved it knows, taken from its OWN block filter rather than
 * from a list maintained here. A hand-written table of expected recipients cannot catch a
 * hand-written mistake, and this is the same class of asymmetry: `notCommentMuted(<author>, ...)` is
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
  [...sql.matchAll(/WHERE ctm\."userId" = ([\s\S]+?)\n\s*AND ctm\."entityType"/g)].map((m) =>
    m[1].trim()
  );

describe('comment notifications — per-thread mute', () => {
  // A name added here silently removes two tests per processor, so the exemption list is pinned as
  // well as documented.
  it('exempts exactly new-mention, on purpose', () => {
    expect([...MUTE_EXEMPT]).toEqual(['new-mention']);
    expect(filteredTypes).toHaveLength(14);
  });

  it('finds the family on the real objects', () => {
    // A sweep over an empty list passes vacuously.
    expect(commentTypes.length).toBeGreaterThanOrEqual(17);
    expect(commentTypes).toContain('new-image-comment');
    expect(commentTypes).toContain('new-mention');
  });

  it.each(filteredTypes)('%s suppresses a muted topic and a muted ancestor', (type) => {
    const sql = sqlFor(type);
    // Both controls: the section mute on the topic and the per-comment mute on an ancestor.
    expect(sql).toContain('"CommentTopicMute" ctm');
    expect(sql).toContain('"CommentMute" cm');
    // Containment, not equality: a join on the exact comment would silence only direct replies.
    expect(sql).toContain('anc.path @> c.path');
    // Keyed on the comment the notification is ABOUT. Passing the parent's alias instead starts
    // containment one level up, so a mute on the parent itself stops matching.
    expect(sql).toContain('ctm."entityType" = c."entityType"');
    // The connector, not just the clause. `OR` binds looser, so it makes the whole WHERE true for
    // any unmuted recipient — past `lastSent`, the self-notify guard and the block filter.
    expect(sql).toMatch(/AND\s+\(NOT EXISTS\s*\(\s*SELECT 1 FROM "CommentTopicMute"/);
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
    expect(sql).toContain('FROM "CommentV3"');
    expect(sql).not.toContain('"CommentMute"');
    expect(sql).not.toContain('"CommentTopicMute"');
  });

  it('leaves the model-page discussion processors alone, and nothing else', () => {
    // The set is derived from the SQL, not from MODEL_ONLY: a processor that reads only model
    // comments and nothing else is the one that may skip the filter.
    const modelOnly = Object.keys(defs).filter((type) => {
      const sql = sqlFor(type);
      return (
        sql.includes(`c."entityType" = 'model'`) &&
        !sql.includes('threadType') &&
        !sql.includes('mention')
      );
    });
    expect(modelOnly.sort()).toEqual([...MODEL_ONLY].sort());
    for (const type of modelOnly) expect(sqlFor(type)).not.toContain('"CommentMute"');
  });

  it('reads no old comment table anywhere in the family', () => {
    for (const type of Object.keys(defs)) {
      const sql = sqlFor(type);
      expect(sql, type).not.toMatch(/"CommentV2"|"Thread"|"ThreadMute"|FROM "Comment" /);
    }
  });
});
