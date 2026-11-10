import { describe, expect, it } from 'vitest';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { modelNotifications } from '~/server/notifications/model.notifications';
import { reactionNotifications } from '~/server/notifications/reaction.notifications';

type Def = {
  prepareMessage: (n: { details: Record<string, unknown> }) => { message: string } | undefined;
};
const defs = {
  ...commentNotifications,
  ...modelNotifications,
  ...reactionNotifications,
} as unknown as Record<string, Def>;

// Every message that names a model as "the <name> model", with the details that reach that branch.
const cases: [label: string, type: string, details: Record<string, unknown>][] = [
  ['new version', 'new-model-version', { versionName: 'v2' }],
  ['comment response', 'new-comment-response', { username: 'ann' }],
  ['thread response', 'new-thread-response', { username: 'ann', parentType: 'comment' }],
  ['review response (v1)', 'new-review-response', { username: 'ann' }],
  ['review response (v3)', 'new-review-response', { username: 'ann', version: 3 }],
  ['image comment (v3)', 'new-image-comment', { username: 'ann', version: 3 }],
  ['image comment (v1)', 'new-image-comment', { username: 'ann' }],
  ['untitled post comment', 'new-post-comment', { username: 'ann' }],
  ['image reaction (v1)', 'image-reaction-milestone', { reactionCount: 5 }],
];

const render = (type: string, details: Record<string, unknown>, modelName: string) =>
  defs[type].prepareMessage({ details: { ...details, modelName } })!.message;

describe('notifications that name a model', () => {
  it.each(cases)('%s: a name starting with "The" gets no second article', (_, type, details) => {
    const message = render(type, details, 'The Weirdies');
    expect(message).toMatch(/(^|\s)The Weirdies model/);
    expect(message).not.toMatch(/\bthe the\b/i);
  });

  it.each(cases)('%s: matched case-insensitively', (_, type, details) => {
    expect(render(type, details, 'the weirdies')).not.toMatch(/\bthe the\b/i);
  });

  it('a sentence that opens with the name still starts with a capital', () => {
    expect(render('new-model-version', { versionName: 'v2' }, 'the weirdies')).toMatch(
      /^The weirdies model/
    );
  });

  it.each(cases)('%s: any other name keeps its article', (_, type, details) => {
    expect(render(type, details, 'Flux Dev')).toMatch(/\b[Tt]he Flux Dev model/);
    expect(render(type, details, 'Theory Mix')).toMatch(/\b[Tt]he Theory Mix model/);
  });
});
