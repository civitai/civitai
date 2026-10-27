import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDiagnostics } from '~/providers/SessionProvider';
import {
  LOGIN_GATE_WITH_AUTH_COOKIE_EVENT,
  buildLoginGateAttributes,
  reportLoginGateWithAuthCookie,
  resetLoginGateReportForTests,
} from '~/utils/faro/loginGate';
import { deepRedact } from '~/utils/faro/redact';

// Wire strings: Loki queries match `event_name=` and these `event_data_*` keys and values.
const EXPECTED_KEYS = [
  'content_nsfw_level',
  'fetch_count',
  'last_fetch',
  'last_fetch_status',
  'last_fetch_trigger',
  'ms_since_nav_start',
  'render_mode',
  'sampleRate',
  'session_boot',
  'session_cookie',
  'session_history',
  'session_source',
  'shell_page_data',
  'shell_seed_session',
];

const ssrNull: SessionDiagnostics = {
  boot: 'ssr-null',
  sessionCookie: true,
  authCookieAtLoad: true,
  history: ['unauthenticated'],
  source: 'ssr',
  fetchCount: 0,
};

const shellAfterFetch: SessionDiagnostics = {
  boot: 'shell',
  sessionCookie: undefined,
  authCookieAtLoad: true,
  history: ['loading', 'authenticated', 'unauthenticated'],
  source: 'fetch:refresh-signal',
  seedSession: 'present',
  fetchCount: 3,
  lastFetch: { trigger: 'refresh-signal', outcome: 'ok-null', httpStatus: 200 },
};

beforeEach(() => resetLoginGateReportForTests());

describe('buildLoginGateAttributes', () => {
  it('a full render that came back signed out with a cookie on the request', () => {
    expect(
      buildLoginGateAttributes({
        diagnostics: ssrNull,
        contentNsfwLevel: 4,
        shellPageDataStatus: undefined,
        msSinceNavStart: 1234.4,
      })
    ).toEqual({
      render_mode: 'ssr',
      session_boot: 'ssr-null',
      session_cookie: 'true',
      session_history: 'unauthenticated',
      session_source: 'ssr',
      shell_seed_session: 'none',
      shell_page_data: 'none',
      last_fetch: 'none',
      last_fetch_status: 'none',
      last_fetch_trigger: 'none',
      fetch_count: '0',
      content_nsfw_level: '4',
      ms_since_nav_start: '1234',
      sampleRate: '1',
    });
  });

  it('a shell whose seed was signed in and a later fetch said signed out', () => {
    expect(
      buildLoginGateAttributes({
        diagnostics: shellAfterFetch,
        contentNsfwLevel: 8,
        shellPageDataStatus: 200,
        msSinceNavStart: 98765.6,
      })
    ).toEqual({
      render_mode: 'shell',
      session_boot: 'shell',
      session_cookie: 'unknown',
      session_history: 'loading>authenticated>unauthenticated',
      session_source: 'fetch:refresh-signal',
      shell_seed_session: 'present',
      shell_page_data: '200',
      last_fetch: 'ok-null',
      last_fetch_status: '200',
      last_fetch_trigger: 'refresh-signal',
      fetch_count: '3',
      content_nsfw_level: '8',
      ms_since_nav_start: '98766',
      sampleRate: '1',
    });
  });

  it('a shell whose page data is not read yet says `pending`', () => {
    expect(
      buildLoginGateAttributes({
        diagnostics: { ...shellAfterFetch, seedSession: undefined },
        contentNsfwLevel: 4,
        shellPageDataStatus: undefined,
        msSinceNavStart: 10,
      })
    ).toMatchObject({ shell_page_data: 'pending', shell_seed_session: 'none' });
  });

  it('carries exactly the documented keys — no user, token, cookie or URL field — and only strings', () => {
    for (const diagnostics of [ssrNull, shellAfterFetch]) {
      const attributes = buildLoginGateAttributes({
        diagnostics,
        contentNsfwLevel: 4,
        shellPageDataStatus: 404,
        msSinceNavStart: 1,
      });
      expect(Object.keys(attributes).sort()).toEqual(EXPECTED_KEYS);
      for (const value of Object.values(attributes)) expect(typeof value).toBe('string');
    }
  });

  it('passes the beforeSend PII scrub unchanged, nested where Faro puts event attributes', () => {
    const attributes = buildLoginGateAttributes({
      diagnostics: shellAfterFetch,
      contentNsfwLevel: 4,
      shellPageDataStatus: 200,
      msSinceNavStart: 1,
    });
    const payload = { events: [{ name: LOGIN_GATE_WITH_AUTH_COOKIE_EVENT, attributes }] };
    expect(deepRedact(payload).events[0].attributes).toEqual(attributes);
  });
});

describe('reportLoginGateWithAuthCookie', () => {
  const signal = (diagnostics: SessionDiagnostics) => ({
    diagnostics,
    contentNsfwLevel: 4,
    shellPageDataStatus: undefined,
    msSinceNavStart: 5,
  });

  it('sends one event per page load', () => {
    const pushEvent = vi.fn();
    expect(reportLoginGateWithAuthCookie(signal(ssrNull), { pushEvent })).toBe('sent');
    expect(reportLoginGateWithAuthCookie(signal(ssrNull), { pushEvent })).toBe('skipped');
    expect(pushEvent).toHaveBeenCalledTimes(1);
    expect(pushEvent.mock.calls[0][0]).toBe('login_gate_with_auth_cookie');
  });

  it('sends nothing for a viewer whose hard load had no session cookie', () => {
    const pushEvent = vi.fn();
    const anon: SessionDiagnostics = { ...ssrNull, sessionCookie: false, authCookieAtLoad: false };
    expect(reportLoginGateWithAuthCookie(signal(anon), { pushEvent })).toBe('skipped');
    expect(pushEvent).not.toHaveBeenCalled();
  });

  it('without Faro it reports `no-faro` and still sends on a later try', () => {
    expect(reportLoginGateWithAuthCookie(signal(ssrNull))).toBe('no-faro');
    const pushEvent = vi.fn();
    expect(reportLoginGateWithAuthCookie(signal(ssrNull), { pushEvent })).toBe('sent');
    expect(pushEvent).toHaveBeenCalledTimes(1);
  });

  it('a throwing Faro does not throw into the gate', () => {
    const pushEvent = vi.fn(() => {
      throw new Error('transport down');
    });
    expect(reportLoginGateWithAuthCookie(signal(ssrNull), { pushEvent })).toBe('skipped');
  });
});
