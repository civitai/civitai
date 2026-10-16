import { describe, expect, it } from 'vitest';
import { splitPlatformContext } from '$lib/feedback-platform';
import { parsePlatformResolutionForm } from '$lib/server/feedback-platform-resolution';

const REPORT = {
  about: 'cli',
  kind: 'bug',
  ref: 'submit.server-refused',
  client: { name: 'civitai-cli', version: '2.3.4' },
  agent: 'claude-code',
  os: 'linux',
  arch: 'x64',
  command: 'civitai apps submit',
  exitCode: 3,
  httpStatus: 422,
  sdk: [
    { name: '@civitai/app-sdk', version: '1.2.0' },
    { name: '@civitai/blocks-react', version: '0.4.1' },
  ],
  docUrl: 'https://developer.civitai.com/apps/submit',
  errorExcerpt: 'Error: REFUSED\n  at submit',
  appSlug: 'my-app',
};

const SERVER = {
  fingerprint: 'ccb33a3af2f5981c140b409d7cd44a50d469685d7c0b5966d4c18609f3681819',
  reporters: 7,
  reports: 13,
  reporterIds: [90817, 90818, 90819],
  firstSeenAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: '2026-10-05T11:11:11.000Z',
  samples: [{ userId: 90818, text: 'same here <b>x</b>', clientVersion: '2.3.1' }],
  reopenOf: 41,
  regressionOf: 43,
  resolution: {
    fixedIn: { component: 'cli', version: '2.4.0' },
    publicNote: 'Fixed in 2.4.0.',
    at: '2026-10-06T00:00:00.000Z',
    byId: 5,
  },
};

describe('splitPlatformContext', () => {
  it('splits a fully populated row into the panel fields with nothing left over', () => {
    const out = splitPlatformContext({ report: REPORT, server: SERVER });
    expect(out.report).toEqual([
      { key: 'about', label: 'About', text: 'cli' },
      { key: 'kind', label: 'Kind', text: 'bug' },
      { key: 'ref', label: 'Failure site', text: 'submit.server-refused' },
      { key: 'client', label: 'Client', text: 'civitai-cli 2.3.4' },
      { key: 'agent', label: 'Agent', text: 'claude-code' },
      { key: 'os', label: 'OS', text: 'linux' },
      { key: 'arch', label: 'Arch', text: 'x64' },
      { key: 'command', label: 'Command', text: 'civitai apps submit' },
      { key: 'exitCode', label: 'Exit code', text: '3' },
      { key: 'httpStatus', label: 'HTTP status', text: '422' },
      { key: 'sdk', label: 'SDK', text: '@civitai/app-sdk 1.2.0, @civitai/blocks-react 0.4.1' },
      { key: 'appSlug', label: 'App', text: 'my-app' },
      { key: 'errorExcerpt', label: 'Error excerpt', text: 'Error: REFUSED\n  at submit' },
    ]);
    expect(out.doc).toEqual({
      text: 'https://developer.civitai.com/apps/submit',
      href: 'https://developer.civitai.com/apps/submit',
    });
    expect(out).toMatchObject({
      fingerprint: SERVER.fingerprint,
      reporters: 7,
      reports: 13,
      reporterIdCount: 3,
      firstSeenAt: SERVER.firstSeenAt,
      lastSeenAt: SERVER.lastSeenAt,
      reopenOf: 41,
      regressionOf: 43,
      resolution: SERVER.resolution,
      samples: [{ userId: 90818, text: 'same here <b>x</b>', clientVersion: '2.3.1' }],
      other: null,
    });
  });

  it('never carries a reporter id out, only the count', () => {
    const out = splitPlatformContext({ report: REPORT, server: SERVER });
    const text = JSON.stringify(out);
    // 90818 is also a sample's author, which the panel does show; the other two are ids only.
    expect(text).not.toContain('90817');
    expect(text).not.toContain('90819');
    expect(text).not.toContain('reporterIds');
  });

  it.each([
    ['a lookalike host', 'https://developer.civitai.com.evil.example/x'],
    ['another scheme', 'http://developer.civitai.com/x'],
    ['a userinfo trick', 'https://developer.civitai.com@evil.example/x'],
    ['a javascript URL', 'javascript:alert(1)//https://developer.civitai.com/'],
  ])('shows a docs URL on %s as text, with no link', (_label, docUrl) => {
    expect(splitPlatformContext({ report: { docUrl } }).doc).toEqual({ text: docUrl, href: null });
  });

  it('moves every value of the wrong type, and every unknown key, to `other`', () => {
    const out = splitPlatformContext({
      report: { about: 'cli', exitCode: '3', client: { name: 'x' }, sdk: 'none', extra: true },
      server: {
        reporters: '7',
        reports: 2.5,
        samples: [{ text: 'ok' }, { text: 4 }],
        reopenOf: -1,
        resolution: { fixedIn: { component: 'cli' }, publicNote: 'n', extra: 1 },
        postCloseReporters: 2,
        postCloseFor: '1791000000000',
      },
      path: '/x',
    });
    expect(out.report).toEqual([{ key: 'about', label: 'About', text: 'cli' }]);
    expect(out.reporters).toBeNull();
    expect(out.samples).toEqual([]);
    // Field by field, as the service reads it: the note is still read back to reporters.
    expect(out.resolution).toEqual({ fixedIn: null, publicNote: 'n', at: null, byId: null });
    expect(out.other).toEqual({
      path: '/x',
      report: { exitCode: '3', client: { name: 'x' }, sdk: 'none', extra: true },
      server: {
        reporters: '7',
        reports: 2.5,
        samples: [{ text: 'ok' }, { text: 4 }],
        reopenOf: -1,
        resolution: { fixedIn: { component: 'cli' }, extra: 1 },
        postCloseReporters: 2,
        postCloseFor: '1791000000000',
      },
    });
  });

  it.each([null, undefined, 7, 'text', [1, 2], { report: 'x', server: [1] }])(
    'does not throw on %j',
    (context) => {
      expect(() => splitPlatformContext(context)).not.toThrow();
    }
  );
});

describe('parsePlatformResolutionForm', () => {
  it('asks for nothing when no mode is posted and no field is filled', () => {
    expect(parsePlatformResolutionForm({})).toEqual({ ok: true, value: undefined });
    expect(parsePlatformResolutionForm({ publicNote: '  ' })).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('trims, and stores a blank version as blank', () => {
    expect(
      parsePlatformResolutionForm({
        resolution: 'set',
        expectedResolutionAt: '',
        fixedInComponent: ' docs ',
        fixedInVersion: '  ',
        publicNote: '  Rewrote the page. ',
      })
    ).toEqual({
      ok: true,
      value: {
        kind: 'set',
        expectedAt: null,
        fixedIn: { component: 'docs', version: '' },
        publicNote: 'Rewrote the page.',
      },
    });
  });

  it('accepts a note alone', () => {
    expect(
      parsePlatformResolutionForm({
        resolution: 'set',
        expectedResolutionAt: '2026-10-06T00:00:00.000Z',
        publicNote: 'n',
      })
    ).toEqual({
      ok: true,
      value: {
        kind: 'set',
        expectedAt: '2026-10-06T00:00:00.000Z',
        fixedIn: null,
        publicNote: 'n',
      },
    });
  });

  it('ignores the boxes on a clear', () => {
    expect(
      parsePlatformResolutionForm({
        resolution: 'clear',
        expectedResolutionAt: '',
        fixedInVersion: 'not a version',
      })
    ).toEqual({ ok: true, value: { kind: 'clear', expectedAt: null } });
  });

  it('refuses a version longer than 32 characters before parsing it', () => {
    const result = parsePlatformResolutionForm({
      resolution: 'set',
      expectedResolutionAt: '',
      fixedInComponent: 'cli',
      fixedInVersion: `1.0.0-${'a'.repeat(27)}`,
    });
    expect(result).toEqual({ ok: false, error: 'A version is at most 32 characters.' });
  });
});
