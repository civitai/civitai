import { describe, expect, it } from 'vitest';
import { createAppFeedbackSchema } from '~/server/schema/app-feedback.schema';

/** What `appFeedback.create` stores in `context`: the closed set, size-capped, nothing else. */

const error = {
  method: 'SUBMIT_WORKFLOW',
  message: 'Validation failed: ecosystem: Ecosystem is currently unavailable',
  code: 'BAD_REQUEST',
  workflowId: 'wf_8412',
  input: { kind: 'textToImage', modelVersionId: 812 },
  at: 1_762_000_000_000,
  count: 2,
};
const input = (context: Record<string, unknown>) => ({
  target: { slug: 'my-app' },
  message: 'the generate button does nothing',
  context: { surface: 'page', ...context },
});
const parse = (context: Record<string, unknown>) =>
  createAppFeedbackSchema.safeParse(input(context));

describe('appFeedbackContextSchema — recentErrors', () => {
  it('keeps a well-formed entry exactly', () => {
    const res = parse({ recentErrors: [error] });
    expect(res.success && res.data.context).toStrictEqual({
      surface: 'page',
      recentErrors: [error],
    });
  });

  it('strips undeclared keys inside an entry and inside its input', () => {
    const res = parse({
      recentErrors: [
        {
          ...error,
          payload: { prompt: 'PROMPT_SENTINEL' },
          input: { ...error.input, params: { prompt: 'PROMPT_SENTINEL' } },
        },
      ],
      consoleErrors: ['HOST_SENTINEL'],
    });
    expect(res.success).toBe(true);
    expect(JSON.stringify(res.data)).not.toMatch(/PROMPT_SENTINEL|HOST_SENTINEL/);
    expect(res.success && res.data.context.recentErrors).toStrictEqual([error]);
  });

  it('caps the list at 10 entries', () => {
    expect(parse({ recentErrors: Array(10).fill(error) }).success).toBe(true);
    expect(parse({ recentErrors: Array(11).fill(error) }).success).toBe(false);
  });

  it('caps the message at 300 characters', () => {
    expect(parse({ recentErrors: [{ ...error, message: 'm'.repeat(300) }] }).success).toBe(true);
    expect(parse({ recentErrors: [{ ...error, message: 'm'.repeat(301) }] }).success).toBe(false);
  });

  it('refuses a method, id or enum key outside its closed shape', () => {
    for (const bad of [
      { method: 'submit workflow' },
      { workflowId: 'wf 1; drop' },
      { code: 'x'.repeat(65) },
      { input: { kind: '<b>' } },
      { input: { modelVersionId: 0 } },
      { count: 0 },
    ])
      expect(parse({ recentErrors: [{ ...error, ...bad }] }).success).toBe(false);
  });
});
