import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { constants } from '~/server/common/constants';

// Cross-app pin: the event engine cannot import the main app's constants, so it keeps its own list
// of the surfaces CommentV3 holds in full. Its count handler counts those from CommentV3 and the
// CommentV2 handler skips them, so a surface read from CommentV3 is never counted from CommentV2.
describe('the surfaces read from CommentV3', () => {
  it('are the ones the event engine counts from CommentV3', () => {
    const handler = readFileSync(
      path.resolve(__dirname, '../../../../apps/event-engine/src/handlers/comment-v3.ts'),
      'utf8'
    );
    const list = /export const COMMENT_V3_SURFACES = \[([^\]]*)\]/.exec(handler)?.[1];
    expect(list).toBeDefined();
    const eventEngine = [...(list ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(eventEngine.sort()).toEqual([...constants.comments.v3ReadSurfaces].sort());
  });
});
