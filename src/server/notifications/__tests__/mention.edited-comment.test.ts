import { describe, expect, it } from 'vitest';
import { mentionNotifications } from '~/server/notifications/mention.notifications';

type Def = { prepareQuery: (args: { lastSent: string }) => string };
const sql = (mentionNotifications as unknown as Record<string, Def>)['new-mention'].prepareQuery({
  lastSent: '2026-10-06T23:38:00.000Z',
});

// The model-description arm is UNIONed on; the comment arm is the one that reads CommentV3.
const commentBranch = () => {
  const branch = sql.split(/UNION/).find((b) => b.includes('FROM "CommentV3" c'));
  if (!branch) throw new Error('no branch reads "CommentV3"');
  return branch;
};

describe('new-mention — a mention added by editing a comment', () => {
  it('rows edited since the last run are re-read', () => {
    expect(commentBranch()).toMatch(
      /c."createdAt" > '2026-10-06T23:38:00.000Z' OR c."updatedAt" > '2026-10-06T23:38:00.000Z'/
    );
  });

  it('edits only count on recently created comments', () => {
    expect(commentBranch()).toContain(
      `c."createdAt" > '2026-10-06T23:38:00.000Z'::timestamp - interval '1 day'`
    );
  });

  it('comments removed by moderation, hidden or deleted stay quiet when edited', () => {
    expect(commentBranch()).toContain(`c."tosViolation" = false`);
    expect(commentBranch()).toContain(`c.hidden IS NOT TRUE`);
    expect(commentBranch()).toContain(`c."deletedAt" IS NULL`);
  });
});
