import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MISSING_MEDIA_PUBLISH_MESSAGE,
  UNRENDERABLE_MEDIA_PUBLISH_MESSAGE,
} from '@civitai/shared';

/**
 * The write-side guard in the spoke's `resolveIngestionError` — the call site that caused the
 * incident. Publishing an image is exactly what this function does (`ingestion = 'Scanned'` plus a
 * locked nsfwLevel), and it used to do it without ever asking whether the media exists.
 *
 * Every case here drives the REAL shared verdict; only the storage probe and the database are
 * stood in for. The three storage answers are covered separately because the fail-open one
 * (`unknown`) is the easy one to get backwards, and getting it backwards turns a storage blip into
 * a moderation outage rather than a missed 404.
 */

type Call = [string, unknown[]];

const updates: Call[][] = [];
const headObject = vi.fn();
const recordModActivity = vi.fn();
const syncSearchIndex = vi.fn();
const bustCachedObject = vi.fn();

/** `undefined` reproduces "no such image", so the earlier not-found check owns that case. */
let imageRow: { postId: number | null; metadata: unknown; url: string } | undefined;

function chain(record: (calls: Call[]) => void, resolve: (calls: Call[]) => unknown) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'set', 'where', 'returning']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    };
  }
  builder.executeTakeFirst = async () => {
    record(calls);
    return resolve(calls);
  };
  builder.execute = async () => {
    record(calls);
    return resolve(calls);
  };
  return builder;
}

vi.mock('../db', () => ({
  dbRead: {},
  dbWrite: {
    selectFrom: (table: string) =>
      chain(
        () => undefined,
        () => {
          expect(table).toBe('Image');
          return imageRow;
        }
      ),
    updateTable: (table: string) =>
      chain(
        (calls) => {
          expect(table).toBe('Image');
          updates.push(calls);
        },
        () => []
      ),
  },
}));

/**
 * 🔴 The two factories return DISTINCT spies on purpose.
 *
 * Returning the same `headObject` for both made them indistinguishable by construction: swapping
 * the probe back to the unbounded `getStorage()` client — reverting the whole 5 s / no-retry budget
 * — passed every test. A mock that cannot tell two collaborators apart cannot pin which one is
 * used, so the assertion below is the only thing holding the bound in place.
 *
 * (Mocking only `getStorage` would not fail at import — vitest replaces the module wholesale, so a
 * missing export surfaces when the binding is ACCESSED, i.e. inside the probe.)
 */
const unboundedHeadObject = vi.fn();
vi.mock('../storage', () => ({
  getStorage: () => ({ headObject: unboundedHeadObject }),
  getMediaProbeStorage: () => ({ headObject }),
}));
vi.mock('../mod-activity', () => ({ recordModActivity }));
vi.mock('../search-index', () => ({ syncSearchIndex }));
vi.mock('../cache', () => ({ bustCachedObject }));

const { resolveIngestionError } = await import('../ingestion.service');

/** The `set()` payload of the publishing UPDATE, or undefined when no UPDATE was issued. */
const published = () =>
  updates[0]?.find(([m]) => m === 'set')?.[1][0] as Record<string, unknown> | undefined;

const resolve = () => resolveIngestionError({ id: 4242, nsfwLevel: 1, userId: 7 });

beforeEach(() => {
  // 🔴 reset, not clear. `clearAllMocks` clears CALLS but leaves IMPLEMENTATIONS installed, so a
  // `mockResolvedValue`/`mockRejectedValue` from an earlier case leaks into every later one — and a
  // case that then forgets to arm the store passes for the wrong reason, or a broken short-circuit
  // is hidden by a leaked `{ exists: true }`.
  vi.resetAllMocks();
  updates.length = 0;
  // postId is null so the post-level recompute (raw SQL against the real client) stays out of the
  // way; it is not what these cases are about.
  imageRow = {
    postId: null,
    metadata: { foo: 'bar' },
    url: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  };
});

describe('spoke resolveIngestionError — missing-media guard', () => {
  it('REFUSES to publish when the store answered that the object is absent', async () => {
    headObject.mockResolvedValue({ exists: false });

    await expect(resolve()).rejects.toThrow(MISSING_MEDIA_PUBLISH_MESSAGE);

    // The whole point: nothing was written. Before this guard the UPDATE below ran unconditionally.
    expect(updates).toHaveLength(0);
    expect(recordModActivity).not.toHaveBeenCalled();
    expect(syncSearchIndex).not.toHaveBeenCalled();
    expect(bustCachedObject).not.toHaveBeenCalled();
  });

  it('probes the image row url against the media backend every image lives in', async () => {
    headObject.mockResolvedValue({ exists: true });
    await resolve();
    expect(headObject).toHaveBeenCalledTimes(1);
    expect(headObject).toHaveBeenCalledWith({
      backend: 'b2Image',
      key: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
  });

  it('publishes exactly as before when the store confirms the object is present', async () => {
    headObject.mockResolvedValue({ exists: true });

    await resolve();

    expect(updates).toHaveLength(1);
    // Literal expectations, not derived from the implementation.
    expect(published()).toMatchObject({
      nsfwLevel: 1,
      nsfwLevelLocked: true,
      ingestion: 'Scanned',
    });
    expect(recordModActivity).toHaveBeenCalledWith({
      userId: 7,
      entityType: 'image',
      entityId: 4242,
      activity: 'setNsfwLevel',
    });
    expect(syncSearchIndex).toHaveBeenCalledTimes(1);
    expect(bustCachedObject).toHaveBeenCalledTimes(2);
  });

  it('publishes and logs when the probe THREW — inability to consult is not evidence of loss', async () => {
    // The fail-open half. A rotated credential, a 5xx, or an unset endpoint all surface here as a
    // throw from the storage client; rejecting on any of them would let a verification step block
    // legitimate moderation on the queue whose job is unblocking content.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      headObject.mockRejectedValue(new Error('storage request failed (503)'));

      await resolve();

      expect(updates).toHaveLength(1);
      expect(published()).toMatchObject({ ingestion: 'Scanned', nsfwLevelLocked: true });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('still refuses before the probe when there is no such image', async () => {
    // Reachability control for the case above: the not-found check runs FIRST, so a fixture with no
    // row never reaches the guard. Any test that forgets to supply a row is testing that check, not
    // this one.
    imageRow = undefined;
    headObject.mockResolvedValue({ exists: false });

    await expect(resolve()).rejects.toThrow('Image not found');
    expect(headObject).not.toHaveBeenCalled();
  });
});

describe('spoke resolveIngestionError — a non-key Image.url is never a missing object', () => {
  /**
   * The mirror of the main app's case, and it exists because the round-1 mutation sweep found this
   * side UNCOVERED: dropping the spoke's short-circuit left every test green. Both runtimes share
   * one rule, so both need a case proving they actually apply it — otherwise "shared" is a claim
   * about the module rather than about the call sites.
   *
   * The store is armed to answer `absent`, so if the probe ran at all the publish would be refused.
   */
  it.each([
    ['an external avatar CDN url', 'https://cdn.discordapp.com/avatars/123/abc.png'],
    ['a bare filename the comics router can write', 'some-file.png'],
    ['a prefixed key shape no upload endpoint issues', 'foo/0f8fad5b-d9cb-469f-a165-70867728950e'],
  ])('publishes without consulting the store for %s', async (_label, url) => {
    imageRow = { postId: null, metadata: {}, url };
    headObject.mockResolvedValue({ exists: false });

    await resolve();

    expect(headObject).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
  });

  it('REFUSES a legacy blob: handle, without consulting the store', async () => {
    /**
     * 🔴 This case used to assert the opposite, on the stated grounds that a `blob:` row "renders
     * perfectly well". It does not. `getEdgeUrl` here and in the main app both return the value
     * VERBATIM for a `blob` prefix, so publishing one emits `<img src="blob:...">` into a browser
     * that never created the handle — a permanently broken image, which is the harm this guard
     * exists to prevent.
     *
     * The store is armed PRESENT, so the refusal demonstrably comes from the url, not the bucket.
     */
    imageRow = { postId: null, metadata: {}, url: 'blob:https://civitai.com/9f8e-1234' };
    headObject.mockResolvedValue({ exists: true });

    await expect(resolve()).rejects.toThrow(UNRENDERABLE_MEDIA_PUBLISH_MESSAGE);

    expect(headObject).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(recordModActivity).not.toHaveBeenCalled();
  });
});

describe('spoke resolveIngestionError — which collaborators the guard reaches', () => {
  it('probes through the BOUNDED client, never the general-purpose one', async () => {
    /**
     * The default client is 10 s x 3 attempts plus backoff — ~31 s on a moderator's click, for an
     * answer that allows either way when it cannot be had. The probe therefore uses a separate 5 s
     * / no-retry client, and this is what stops that from being silently reverted.
     */
    headObject.mockResolvedValue({ exists: true });

    await resolve();

    // The distinguishing assertion FIRST: three other tests already assert `headObject` was called,
    // so leading with that made this one die to a shared assertion and name the wrong regression.
    expect(unboundedHeadObject).not.toHaveBeenCalled();
    expect(headObject).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal, so a fail-CLOSED misconfiguration cannot look like a clean run', async () => {
    // A wrong bucket name 404s for EVERY key, which reads as `absent` for every image. Without this
    // wiring the guard would refuse every publish and emit nothing to say so.
    // try/finally: this config sets no `restoreMocks`, so a failing assertion would otherwise leave
    // `console.warn` stubbed for the rest of the worker.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      headObject.mockResolvedValue({ exists: false });

      await expect(resolve()).rejects.toThrow(MISSING_MEDIA_PUBLISH_MESSAGE);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('refused publish');
      // Carries WHICH refusal. A bucket can produce `absent` and can never produce `unrenderable`,
      // so a fail-CLOSED misconfiguration is only legible if the two are counted apart.
      expect(warn.mock.calls[0]).toContain('absent');
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds the probe error it logs, so a remote response body cannot flood the log', async () => {
    /**
     * A `StorageClientError` embeds the remote response BODY in its message verbatim — unbounded
     * third-party text (an HTML error page, an XML fault) written to stdout and therefore Loki once
     * per inconclusive probe. The guard logs a bounded summary instead of the error.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      headObject.mockRejectedValue(new Error(`storage request failed (503) ${'x'.repeat(10_000)}`));

      await resolve();

      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls[0].map(String).join(' ');
      expect(logged.length).toBeLessThan(500);
      expect(logged).toContain('storage request failed (503)');
      expect(logged).toContain('[truncated]');
    } finally {
      warn.mockRestore();
    }
  });
});
