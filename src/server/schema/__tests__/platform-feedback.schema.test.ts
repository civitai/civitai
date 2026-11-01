import { describe, expect, it } from 'vitest';
import {
  createPlatformFeedbackSchema,
  getPlatformFeedbackStatusSchema,
  platformFeedbackReportSchema,
} from '~/server/schema/platform-feedback.schema';

/**
 * `platformFeedback.create` / `getStatus` input. Two properties carry the design: only declared
 * `report` keys reach the column (the server-owned half of the context cannot be sent), and every
 * bound REJECTS one over instead of clipping.
 */

const fullReport = {
  about: 'cli',
  kind: 'confusing',
  ref: 'submit.server-refused',
  client: { name: 'civitai-cli', version: '2.3.4-rc.1+build5' },
  agent: 'claude-code',
  os: 'linux',
  arch: 'arm64',
  command: 'civitai app submit --dry-run',
  exitCode: 3,
  httpStatus: 422,
  sdk: [{ name: '@civitai/app-sdk', version: '0.9.1' }],
  docUrl: 'https://developer.civitai.com/apps/submit',
  errorExcerpt: 'manifest: scopes[2] is not a known scope',
  appSlug: 'my-app',
} as const;

const minimalReport = { about: 'docs', client: { name: 'other', version: '1' } } as const;

const parseReport = (patch: Record<string, unknown>) =>
  platformFeedbackReportSchema.safeParse({ ...minimalReport, ...patch });

describe('platform feedback report schema', () => {
  it('keeps every declared key', () => {
    expect(platformFeedbackReportSchema.parse(fullReport)).toEqual(fullReport);
  });

  it('defaults kind to bug and leaves absent optionals absent', () => {
    expect(platformFeedbackReportSchema.parse(minimalReport)).toEqual({
      about: 'docs',
      kind: 'bug',
      client: { name: 'other', version: '1' },
    });
  });

  it('strips a client-sent server object and unknown keys, at every level', () => {
    const parsed = createPlatformFeedbackSchema.parse({
      message: 'the submit hint is wrong',
      server: { fingerprint: 'f'.repeat(64), reporters: 999 },
      fingerprint: 'f'.repeat(64),
      report: {
        ...minimalReport,
        server: { reporters: 999, resolution: { publicNote: 'fixed!' } },
        fingerprint: 'f'.repeat(64),
        client: { name: 'other', version: '1', server: { reports: 999 } },
        sdk: [{ name: 'a', version: '1', regressionOf: 7 }],
      },
    });
    expect(parsed).toEqual({
      message: 'the submit hint is wrong',
      report: {
        about: 'docs',
        kind: 'bug',
        client: { name: 'other', version: '1' },
        sdk: [{ name: 'a', version: '1' }],
      },
    });
  });

  it('requires about and client', () => {
    expect(platformFeedbackReportSchema.safeParse({ client: minimalReport.client }).success).toBe(
      false
    );
    expect(platformFeedbackReportSchema.safeParse({ about: 'docs' }).success).toBe(false);
  });

  // Hand-typed: these lists are the contract the CLI is written against.
  it.each(['cli', 'sdk', 'docs', 'review', 'sandbox', 'scopes', 'mcp', 'other'])(
    'accepts about: %s',
    (about) => {
      expect(parseReport({ about }).data?.about).toBe(about);
    }
  );

  it.each(['bug', 'confusing', 'missing', 'request'])('accepts kind: %s', (kind) => {
    expect(parseReport({ kind }).data?.kind).toBe(kind);
  });

  it.each(['civitai-cli', 'civitai-mcp', 'other'])('accepts client.name: %s', (name) => {
    expect(parseReport({ client: { name, version: '1.0.0' } }).data?.client.name).toBe(name);
  });

  it.each([
    ['about', { about: 'billing' }],
    ['kind', { kind: 'praise' }],
    ['client.name', { client: { name: 'curl', version: '1' } }],
  ])('rejects a value outside the %s enum', (_field, patch) => {
    expect(parseReport(patch).success).toBe(false);
  });

  // Each row is [field, a value AT the bound, the same value one over]. The at-bound half is the
  // control: without it a field that rejected everything would pass.
  const s = (n: number) => 'a'.repeat(n);
  it.each([
    ['ref', { ref: s(80) }, { ref: s(81) }],
    [
      'client.version',
      { client: { name: 'other', version: s(32) } },
      { client: { name: 'other', version: s(33) } },
    ],
    ['agent', { agent: s(40) }, { agent: s(41) }],
    ['os', { os: s(16) }, { os: s(17) }],
    ['arch', { arch: s(16) }, { arch: s(17) }],
    ['command', { command: s(120) }, { command: s(121) }],
    ['exitCode', { exitCode: 255 }, { exitCode: 256 }],
    ['exitCode floor', { exitCode: 0 }, { exitCode: -1 }],
    ['httpStatus', { httpStatus: 599 }, { httpStatus: 600 }],
    ['httpStatus floor', { httpStatus: 100 }, { httpStatus: 99 }],
    [
      'sdk count',
      { sdk: Array.from({ length: 4 }, () => ({ name: 'n', version: '1' })) },
      { sdk: Array.from({ length: 5 }, () => ({ name: 'n', version: '1' })) },
    ],
    [
      'sdk name',
      { sdk: [{ name: s(40), version: '1' }] },
      { sdk: [{ name: s(41), version: '1' }] },
    ],
    [
      'sdk version',
      { sdk: [{ name: 'n', version: s(32) }] },
      { sdk: [{ name: 'n', version: s(33) }] },
    ],
    [
      'docUrl',
      { docUrl: `https://developer.civitai.com/${s(270)}` },
      { docUrl: `https://developer.civitai.com/${s(271)}` },
    ],
    ['errorExcerpt', { errorExcerpt: s(500) }, { errorExcerpt: s(501) }],
    ['appSlug', { appSlug: s(64) }, { appSlug: s(65) }],
  ])('%s: accepts the bound and rejects one over', (_field, atBound, over) => {
    expect(parseReport(atBound).success).toBe(true);
    expect(parseReport(over).success).toBe(false);
  });

  it.each([1.5, '3'])('rejects a non-integer exitCode (%s)', (exitCode) => {
    expect(parseReport({ exitCode }).success).toBe(false);
  });

  it.each([404.5, '404'])('rejects a non-integer httpStatus (%s)', (httpStatus) => {
    expect(parseReport({ httpStatus }).success).toBe(false);
  });

  // Postgres stores neither a NUL nor an unpaired surrogate, so they are refused here instead of
  // failing the write. A whole emoji (a PAIRED surrogate) is the control.
  const UNSTORABLE = [
    ['a NUL', 'std\u0000err'],
    ['a lone high surrogate', 'cut \uD83D'],
    ['a lone low surrogate', '\uDE00 cut'],
    ['a low surrogate after a whole pair', '\uD83D\uDE00\uDE00'],
    ['a high surrogate before a whole pair', '\uD83D\uD83D\uDE00'],
  ] as const;
  const TEXT_FIELDS = ['agent', 'os', 'arch', 'command', 'errorExcerpt', 'appSlug'] as const;

  it.each(TEXT_FIELDS)('%s: accepts an emoji and refuses unstorable text', (field) => {
    expect(parseReport({ [field]: 'ok \u{1F600}' }).success).toBe(true);
    for (const [, value] of UNSTORABLE) {
      const result = parseReport({ [field]: value });
      expect(result.error?.issues.map((i) => [i.path, i.message])).toEqual([
        [[field], 'Contains a character that cannot be stored.'],
      ]);
    }
  });

  it.each(UNSTORABLE)('refuses %s in sdk entries, docUrl and the message', (_label, value) => {
    expect(parseReport({ sdk: [{ name: value, version: '1' }] }).success).toBe(false);
    expect(parseReport({ sdk: [{ name: 'n', version: value }] }).success).toBe(false);
    expect(parseReport({ docUrl: `https://developer.civitai.com/${value}` }).success).toBe(false);
    const message = createPlatformFeedbackSchema.safeParse({
      message: value,
      report: minimalReport,
    });
    expect(message.error?.issues.map((i) => [i.path, i.message])).toEqual([
      [['message'], 'Contains a character that cannot be stored.'],
    ]);
  });

  it.each(['Submit.refused', '-leading-dash', 'has space', 'slash/inside', ''])(
    'rejects a ref outside the key shape (%j)',
    (ref) => {
      expect(parseReport({ ref }).success).toBe(false);
    }
  );

  it.each(['1.2.3 beta', 'v1/2', ''])('rejects a client version outside its charset (%j)', (v) => {
    expect(parseReport({ client: { name: 'civitai-cli', version: v } }).success).toBe(false);
  });

  it.each([
    'https://civitai.com/apps/submit',
    'http://developer.civitai.com/apps',
    'https://developer.civitai.com.evil.example/apps',
    'https://developer.civitai.com',
    'javascript:alert(1)',
  ])('rejects a docUrl outside the developer docs (%s)', (docUrl) => {
    expect(parseReport({ docUrl }).success).toBe(false);
  });
});

describe('platform feedback create schema', () => {
  it('trims the message and rejects an empty or over-long one', () => {
    const parse = (message: string) =>
      createPlatformFeedbackSchema.safeParse({ message, report: minimalReport });
    expect(parse('  padded  ').data?.message).toBe('padded');
    expect(parse('   ').success).toBe(false);
    expect(parse('m'.repeat(2000)).success).toBe(true);
    expect(parse('m'.repeat(2001)).success).toBe(false);
  });

  it('requires a report', () => {
    expect(createPlatformFeedbackSchema.safeParse({ message: 'no report' }).success).toBe(false);
  });
});

describe('platform feedback getStatus schema', () => {
  const refs = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}-0a1b2c3d`);

  it('accepts 1 to 50 refs and rejects 0 or 51', () => {
    expect(getPlatformFeedbackStatusSchema.safeParse({ refs: refs(1) }).success).toBe(true);
    expect(getPlatformFeedbackStatusSchema.safeParse({ refs: refs(50) }).success).toBe(true);
    expect(getPlatformFeedbackStatusSchema.safeParse({ refs: [] }).success).toBe(false);
    expect(getPlatformFeedbackStatusSchema.safeParse({ refs: refs(51) }).success).toBe(false);
  });

  // The shape is the service's to judge (a malformed ref answers found:false); the schema only
  // caps the size of the input.
  it('accepts any string up to 80 characters as a ref, and rejects a longer one', () => {
    const parse = (ref: unknown) => getPlatformFeedbackStatusSchema.safeParse({ refs: [ref] });
    expect(parse('2147483647-0a1b2c3d').success).toBe(true);
    expect(parse('not a ref').success).toBe(true);
    expect(parse('').success).toBe(true);
    expect(parse('r'.repeat(80)).success).toBe(true);
    expect(parse('r'.repeat(81)).success).toBe(false);
    expect(parse(7).success).toBe(false);
  });
});
