import { describe, expect, it } from 'vitest';
import { mentionNotifications } from '~/server/notifications/mention.notifications';

type Def = { prepareQuery: (args: { lastSent: string }) => string };
const sql = (mentionNotifications as unknown as Record<string, Def>)['new-mention'].prepareQuery({
  lastSent: '2026-10-06T23:38:00.000Z',
});

const branches = sql.split(/\bUNION\b/);
const commentBranch = (table: string) => {
  const branch = branches.find((b) => b.includes(`FROM "${table}" c`));
  if (!branch) throw new Error(`no branch reads "${table}"`);
  return branch;
};

describe('new-mention — a mention added by editing a comment', () => {
  it.each(['CommentV2', 'Comment'])('%s rows edited since the last run are re-read', (table) => {
    expect(commentBranch(table)).toMatch(
      /c\."createdAt" > '2026-10-06T23:38:00\.000Z' OR c\."updatedAt" > '2026-10-06T23:38:00\.000Z'/
    );
  });

  it.each(['CommentV2', 'Comment'])('%s edits only count on recently created comments', (table) => {
    expect(commentBranch(table)).toContain(
      `c."createdAt" > '2026-10-06T23:38:00.000Z'::timestamp - interval '1 day'`
    );
  });

  it.each(['CommentV2', 'Comment'])(
    '%s comments removed by moderation or hidden stay quiet when edited',
    (table) => {
      expect(commentBranch(table)).toContain(`c."tosViolation" = false`);
      expect(commentBranch(table)).toContain(`c.hidden IS NOT TRUE`);
    }
  );
});
