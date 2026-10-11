import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

function bodyOf(file: string, signature: string) {
  const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const start = source.indexOf(signature);
  expect(start, `${signature} not found in ${file}`).toBeGreaterThan(-1);
  const end = source.indexOf('\nexport ', start + signature.length);
  return source.slice(start, end === -1 ? undefined : end);
}

describe('every scam write path queues a scan', () => {
  it.each([
    ['src/server/services/comment.service.ts', 'export const createOrUpdateComment', 'Comment', 1],
    ['src/server/services/commentsv2.service.ts', 'export const upsertComment', 'CommentV2', 2],
    ['src/server/routers/comics.router.ts', 'dbWrite.commentV2.create', 'CommentV2', 1],
    [
      'src/server/services/resourceReview.service.ts',
      'export const upsertResourceReview',
      'ResourceReview',
      2,
    ],
    [
      'src/server/services/resourceReview.service.ts',
      'export const createResourceReview',
      'ResourceReview',
      1,
    ],
    [
      'src/server/services/resourceReview.service.ts',
      'export const updateResourceReview',
      'ResourceReview',
      1,
    ],
    [
      'src/server/services/user-profile.service.ts',
      'export const updateUserProfile',
      'UserProfile',
      1,
    ],
    ['src/server/services/user.service.ts', 'export const updateUserById', 'User', 1],
    [
      'src/server/controllers/user.controller.ts',
      'export const completeOnboardingHandler',
      'User',
      1,
    ],
    [
      'src/server/controllers/chat.controller.ts',
      'export const updateMessageHandler',
      'ChatMessage',
      1,
    ],
  ])('%s › %s queues %s (%i site(s))', (file, signature, entityType, sites) => {
    const body = bodyOf(file, signature);
    const calls = body.split(`queueScamScan({ entityType: '${entityType}'`).length - 1;
    expect(calls).toBe(sites);
  });

  it('username paths scan only a changed username', () => {
    expect(bodyOf('src/server/services/user.service.ts', 'export const updateUserById')).toContain(
      'data.username !== previousUsername'
    );
    expect(
      bodyOf('src/server/controllers/user.controller.ts', 'export const completeOnboardingHandler')
    ).toContain('input.username !== current?.username');
  });
});
