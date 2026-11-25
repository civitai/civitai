import { describe, it, expect } from 'vitest';
import { patchSchema } from '~/server/schema/orchestrator/workflows.schema';

const workflowPatch = (patch: Record<string, unknown>) =>
  patchSchema.safeParse({ workflows: [{ workflowId: '5-1', patches: [patch] }] }).success;

describe('orchestrator.patch workflow patches', () => {
  it.each([
    { op: 'replace', path: '/allowMatureContent', value: true },
    { op: 'replace', path: '/AllowMatureContent', value: true },
    { op: 'copy', from: '/metadata/x', path: '/allowMatureContent' },
    { op: 'move', from: '/allowMatureContent', path: '/metadata/x' },
    { op: 'add', path: '/metadataX', value: 1 },
    { op: 'add', path: '', value: {} },
  ])('rejects $op $path (from $from)', (patch) => {
    expect(workflowPatch(patch)).toBe(false);
  });

  it.each([
    { op: 'add', path: '/metadata', value: {} },
    { op: 'add', path: '/metadata/note', value: 'x' },
    { op: 'replace', path: '/Metadata/note', value: 'x' },
    { op: 'copy', from: '/metadata/a', path: '/metadata/b' },
  ])('accepts $op $path', (patch) => {
    expect(workflowPatch(patch)).toBe(true);
  });

  it('leaves step patch paths, which the router roots under /metadata, unrestricted', () => {
    const result = patchSchema.safeParse({
      steps: [
        {
          workflowId: '5-1',
          stepName: '$0',
          patches: [{ op: 'add', path: 'output/1/feedback', value: 'liked' }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// Decision (civitai/civitai#10435): only an App Blocks submit puts an app-block tag on a workflow; an owner may still
// remove one. Keep removal open: it narrows an app's access and fails closed.
describe('orchestrator.patch workflow tags', () => {
  const tags = (...input: { tag: string; op: 'add' | 'remove' }[]) =>
    patchSchema.safeParse({ tags: input.map((t) => ({ workflowId: '5-1', ...t })) });

  it.each([
    'app-block:my-app',
    'App-Block:my-app',
    '  app-block:my-app',
    'app-block',
    ' App-Block ',
  ])('🔴 refuses adding %j, with a message naming the tag', (tag) => {
    const result = tags({ tag: 'favorite', op: 'add' }, { tag, op: 'add' });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['tags', 1, 'tag'],
        message: 'App block tags are set by the app, not added by hand.',
      }),
    ]);
  });

  it('still allows removing an app-block tag', () => {
    expect(tags({ tag: 'app-block:my-app', op: 'remove' }).success).toBe(true);
    expect(tags({ tag: 'app-block', op: 'remove' }).success).toBe(true);
  });

  it('accepts other tags, including ones that only contain the prefix later', () => {
    expect(
      tags(
        { tag: 'favorite', op: 'add' },
        { tag: 'feedback:liked', op: 'remove' },
        { tag: 'my-app-block:x', op: 'add' }
      ).success
    ).toBe(true);
  });
});
