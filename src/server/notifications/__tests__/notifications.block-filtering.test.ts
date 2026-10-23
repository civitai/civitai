import { describe, expect, it } from 'vitest';
import { articleNotifications } from '~/server/notifications/article.notifications';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import { modelNotifications } from '~/server/notifications/model.notifications';

/**
 * Every comment notification must drop recipients on either side of a block.
 *
 * The write guard stops a blocked user commenting on the blocker's content, but a comment made
 * anywhere else still reaches the blocker through thread/mention notifications — so the block only
 * holds if this family filters too. Asserted on the generated SQL (pure — no DB).
 *
 * The sweep over EVERY processor is the point: this family grows a processor per new commentable
 * surface, and one added without the filter is silent — it reads as a working notification and
 * only the blocked pair ever sees the difference.
 */

type Def = { prepareQuery?: (args: { lastSent: string }) => string };
const defs = commentNotifications as unknown as Record<string, Def>;

const sqlFor = (type: string) => defs[type].prepareQuery?.({ lastSent: '2026-01-01' }) ?? '';

const sqlTypes = Object.entries(defs)
  .filter(([, def]) => typeof def.prepareQuery === 'function')
  .map(([type]) => type);

describe('comment notifications — block filtering', () => {
  it('covers every SQL-backed processor in the family', () => {
    // A guard over an empty list passes vacuously; this pins that the family was actually found.
    expect(sqlTypes.length).toBeGreaterThanOrEqual(15);
  });

  it.each(sqlTypes)('%s filters recipients blocked either way', (type) => {
    const q = sqlFor(type);
    expect(q).toContain('"UserEngagement" blk');
    // Recipient blocked or hid the author...
    expect(q).toMatch(/blk\.type IN \('Block', ?'Hide'\)/);
    // ...and the author blocked the recipient. Both halves, or the block only holds one way.
    expect(q).toMatch(/blk\.type = 'Block'/);
  });

  // `new-thread-response` builds its recipients with UNNEST(ARRAY_AGG(...)), so the block filter
  // has to sit inside the aggregate, against each fellow participant, rather than in a shared WHERE.
  it('new-thread-response filters inside the participant aggregate', () => {
    const q = sqlFor('new-thread-response');
    expect(q).toContain('FROM "CommentV3" cu');
    const aggregate = q.slice(q.indexOf('ARRAY_AGG'), q.indexOf('"ownerId"'));
    // Two arms (top-level siblings, reply siblings), each filtering its own participants.
    expect(aggregate.match(/"UserEngagement" blk/g)).toHaveLength(2);
    expect(aggregate).toMatch(/blk."userId" = s."userId" AND blk."targetUserId" = c."userId"/);
  });

  it('filters on the recipient, not only on the comment author', () => {
    // Guards against a filter that compares the author to themselves — which excludes nothing and
    // would still satisfy every "contains UserEngagement" assertion above.
    const q = sqlFor('new-comment');
    expect(q).toMatch(/blk\."userId" = m\."userId" AND blk\."targetUserId" = c\."userId"/);
    expect(q).toMatch(/blk\."userId" = c\."userId" AND blk\."targetUserId" = m\."userId"/);
  });
});

/**
 * The families outside the comment tree that name an acting user. Each reaches the recipient by a
 * route the write-path block guard never sees: a mention travels from content the blocker never
 * touched, and a follow is normally set BEFORE the block that follows it, so the Follow row
 * outlives the block and keeps delivering.
 */
describe('actor-derived notifications outside the comment family', () => {
  const others: Record<string, Def> = {
    'new-mention': (mentionNotifications as unknown as Record<string, Def>)['new-mention'],
    'new-model-from-following': (modelNotifications as unknown as Record<string, Def>)[
      'new-model-from-following'
    ],
    'new-model-version': (modelNotifications as unknown as Record<string, Def>)[
      'new-model-version'
    ],
    'new-article-from-following': (articleNotifications as unknown as Record<string, Def>)[
      'new-article-from-following'
    ],
  };

  it.each(Object.keys(others))('%s filters recipients blocked either way', (type) => {
    const q = others[type].prepareQuery?.({ lastSent: '2026-01-01' }) ?? '';
    expect(q).toContain('"UserEngagement" blk');
    expect(q).toMatch(/blk\.type IN \('Block', ?'Hide'\)/);
    expect(q).toMatch(/blk\.type = 'Block'/);
  });

  // new-mention UNIONs three branches and derives its recipient with unnest() in the SELECT list,
  // where no WHERE clause can see it. Each branch carries its author out as `actorId` so the filter
  // can run once on the outer query — a branch that forgets the column is a SQL error, but one that
  // selects the WRONG user silently notifies across the block.
  it('new-mention carries the acting user out of every union branch', () => {
    const q = others['new-mention'].prepareQuery?.({ lastSent: '2026-01-01' }) ?? '';
    // The comment arm and the model-description arm.
    expect(q.match(/"userId" "actorId"/g)).toHaveLength(2);
    expect(q).toMatch(/blk\."userId" = r\."ownerId" AND blk\."targetUserId" = r\."actorId"/);
  });

  // new-model-version fans out to followers of the creator AND to users who asked to be notified
  // about that specific model. Two independent recipient sources, two filters needed.
  it('new-model-version filters both recipient sources', () => {
    const q = others['new-model-version'].prepareQuery?.({ lastSent: '2026-01-01' }) ?? '';
    expect(q.match(/"UserEngagement" blk/g)).toHaveLength(2);
    expect(q).toMatch(/blk\."userId" = ue\."userId"/);
    expect(q).toMatch(/blk\."userId" = me\."userId"/);
  });
});
