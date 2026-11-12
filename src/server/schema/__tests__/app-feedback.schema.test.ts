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

  it('keeps a host refusal with its reason, scopes and app route', () => {
    const refusal = {
      method: 'NAVIGATE',
      message: 'rewritten',
      reason: 'rewritten',
      scope: { requested: 'unspecified', resolved: 'app' },
      appRoute: '/generate',
      at: 1,
      count: 1,
    };
    const res = parse({ recentErrors: [refusal] });
    expect(res.success && res.data.context.recentErrors).toStrictEqual([refusal]);
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
      { reason: 'because' },
      { scope: { requested: 'everywhere' } },
      { appRoute: 'r'.repeat(201) },
    ])
      expect(parse({ recentErrors: [{ ...error, ...bad }] }).success).toBe(false);
  });
});

describe('appFeedbackContextSchema — environment', () => {
  const environment = {
    browser: { family: 'chrome', major: 131 },
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 2,
    appRoute: '/gallery/12',
  };

  it('keeps a well-formed block exactly, and strips a raw user agent or anything else', () => {
    const res = parse({
      environment: {
        ...environment,
        userAgent: 'Mozilla/5.0 UA_SENTINEL',
        browser: { ...environment.browser, fullVersion: '131.0.6778.85' },
      },
    });
    expect(res.success && res.data.context.environment).toStrictEqual(environment);
    expect(JSON.stringify(res.data)).not.toMatch(/UA_SENTINEL|6778/);
  });

  it('refuses a family outside the closed set and a route past 200 characters', () => {
    expect(parse({ environment: { browser: { family: 'netscape' } } }).success).toBe(false);
    expect(parse({ environment: { os: 'windows', scrollbars: 'classic' } }).success).toBe(true);
    expect(parse({ environment: { os: 'beos' } }).success).toBe(false);
    expect(parse({ environment: { scrollbars: 'thin' } }).success).toBe(false);
    expect(parse({ environment: { appRoute: 'r'.repeat(200) } }).success).toBe(true);
    expect(parse({ environment: { appRoute: 'r'.repeat(201) } }).success).toBe(false);
    expect(parse({ environment: { viewport: { width: -1, height: 2 } } }).success).toBe(false);
  });
});
