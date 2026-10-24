import { describe, expect, it } from 'vitest';
import { muteableThreadsCte, seededThreadChainCte } from '~/server/common/thread-chain';

// Two walkers climb the same edge. It must stay the stored Thread.commentId one in both, never a
// client-written parent or root pointer.
describe('thread chain walkers', () => {
  it.each([
    ['muteableThreadsCte', muteableThreadsCte('1')],
    ['seededThreadChainCte', seededThreadChainCte('SELECT 1 "seedId", 1 "threadId"')],
  ])('%s climbs Thread.commentId -> CommentV2.threadId only', (_, sql) => {
    expect(sql).toMatch(
      /JOIN "Thread" th ON th\.id = \w+\."id"\s+JOIN "CommentV2" pc ON pc\.id = th\."commentId"/
    );
    expect(sql).not.toMatch(/parentThreadId|rootThreadId/);
  });
});
