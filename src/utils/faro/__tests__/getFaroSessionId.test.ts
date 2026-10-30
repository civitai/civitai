import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_SESSION_ID_MAX_LENGTH } from '~/shared/constants/feedback.constants';

/**
 * `getFaroSessionId` — reading the RUM session id, with ABSENCE as a first-class case.
 *
 * `FaroProvider` only calls `initializeFaro` when the build-arg, the collector URL
 * and the `faro` feature flag all agree, so Faro is NOT running in dev, test or
 * preview, and in production it is still absent for any session that blocked or
 * did not sample the SDK. Until then the SDK's `faro` export is a bare `{}`.
 *
 * The uninitialised shapes below are modelled on that: `{}` (never initialised),
 * `{ api: {} }` (partially wired), and an `api.getSession()` that returns
 * `undefined` (running, no session). None of them may throw, because the caller is
 * a submit handler and a throw there would make feedback unsubmittable on every
 * non-production build.
 */

const { faro } = vi.hoisted(() => ({ faro: {} as Record<string, unknown> }));

vi.mock('@grafana/faro-web-sdk', () => ({ faro }));

const { getFaroSessionId } = await import('~/utils/faro/getFaroSessionId');

/** Replace the mocked module's `faro` object in place — the import is a live binding. */
const setFaro = (value: Record<string, unknown>) => {
  for (const key of Object.keys(faro)) delete faro[key];
  Object.assign(faro, value);
};

const withSession = (session: unknown) => setFaro({ api: { getSession: () => session } });

beforeEach(() => setFaro({}));

describe('Faro is running', () => {
  it('returns the session id', () => {
    withSession({ id: 'sess-abc123' });
    expect(getFaroSessionId()).toBe('sess-abc123');
  });

  it('trims surrounding whitespace', () => {
    withSession({ id: '  sess-abc123  ' });
    expect(getFaroSessionId()).toBe('sess-abc123');
  });

  it('truncates an over-long id to the boundary schema’s bound rather than failing', () => {
    withSession({ id: 'x'.repeat(FEEDBACK_SESSION_ID_MAX_LENGTH + 50) });
    const id = getFaroSessionId();
    expect(id).toHaveLength(64);
    expect(FEEDBACK_SESSION_ID_MAX_LENGTH).toBe(64);
  });
});

describe('🔴 Faro is absent — the ordinary dev/test/preview case', () => {
  it('returns undefined when the SDK was never initialised', () => {
    setFaro({});
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('returns undefined when `api` exists but has no getSession', () => {
    setFaro({ api: {} });
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('returns undefined when there is no active session', () => {
    withSession(undefined);
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('returns undefined when the session carries no id', () => {
    withSession({});
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('returns undefined for a non-string id', () => {
    withSession({ id: 12345 });
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('returns undefined for a whitespace-only id', () => {
    withSession({ id: '   ' });
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('does not throw when getSession itself throws', () => {
    setFaro({
      api: {
        getSession: () => {
          throw new Error('faro is paused');
        },
      },
    });
    expect(() => getFaroSessionId()).not.toThrow();
    expect(getFaroSessionId()).toBeUndefined();
  });
});
