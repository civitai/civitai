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
