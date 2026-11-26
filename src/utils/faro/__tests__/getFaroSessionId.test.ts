import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_SESSION_ID_MAX_LENGTH } from '~/shared/constants/feedback.constants';

/**
 * `getFaroSessionId` — reading the RUM session id, with ABSENCE as a first-class case.
 *
 * `FaroProvider` only calls `initializeFaro` when the build-arg, the collector URL
 * and the `faro` feature flag all agree, so Faro is NOT running in dev, test or
 * preview, and in production it is still absent for any browser that blocked the
 * SDK. Until then the SDK's `faro` export is a bare `{}`. A running SDK whose
 * session was not sampled also yields no id: nothing is stored under it.
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

/** A session the SDK sampled: faro-web-sdk stamps `attributes.isSampled` as the string `'true'`. */
const sampled = (fields: Record<string, unknown>) => ({
  ...fields,
  attributes: { isSampled: 'true', region: 'eu' },
});

beforeEach(() => setFaro({}));

describe('Faro is running', () => {
  it('returns the session id', () => {
    withSession(sampled({ id: 'sess-abc123' }));
    expect(getFaroSessionId()).toBe('sess-abc123');
  });

  it('trims surrounding whitespace', () => {
    withSession(sampled({ id: '  sess-abc123  ' }));
    expect(getFaroSessionId()).toBe('sess-abc123');
  });

  it('truncates an over-long id to the boundary schema’s bound rather than failing', () => {
    withSession(sampled({ id: 'x'.repeat(FEEDBACK_SESSION_ID_MAX_LENGTH + 50) }));
    const id = getFaroSessionId();
    expect(id).toHaveLength(64);
    expect(FEEDBACK_SESSION_ID_MAX_LENGTH).toBe(64);
  });
});

describe('🔴 the session was not sampled — its id names no telemetry', () => {
  // The SDK still creates a session and an id for an unsampled session, but its transport drops
  // every item unless `attributes.isSampled === 'true'`. A report must not point at that id.
  it('returns undefined when the session is marked unsampled', () => {
    withSession({ id: 'sess-abc123', attributes: { isSampled: 'false', region: 'eu' } });
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('returns undefined when the session carries no sampling attribute', () => {
    withSession({ id: 'sess-abc123', attributes: { region: 'eu' } });
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('returns undefined when the session carries no attributes at all', () => {
    withSession({ id: 'sess-abc123' });
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('accepts only the string the SDK writes, not a boolean', () => {
    withSession({ id: 'sess-abc123', attributes: { isSampled: true } });
    expect(getFaroSessionId()).toBeUndefined();
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
    withSession(sampled({}));
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('returns undefined for a non-string id', () => {
    withSession(sampled({ id: 12345 }));
    expect(getFaroSessionId()).toBeUndefined();
  });

  it('returns undefined for a whitespace-only id', () => {
    withSession(sampled({ id: '   ' }));
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
