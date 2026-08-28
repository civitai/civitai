import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MISSING_MEDIA_PUBLISH_MESSAGE } from '@civitai/shared';

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

// Both factories: the probe deliberately uses a SEPARATE, tightly-bounded client, and mocking only
// `getStorage` would leave the real one in place and fail at import.
vi.mock('../storage', () => ({
  getStorage: () => ({ headObject }),
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
  vi.clearAllMocks();
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
    headObject.mockRejectedValue(new Error('storage request failed (503)'));

    await resolve();

    expect(updates).toHaveLength(1);
    expect(published()).toMatchObject({ ingestion: 'Scanned', nsfwLevelLocked: true });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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
