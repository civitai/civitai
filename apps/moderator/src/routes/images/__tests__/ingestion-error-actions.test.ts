import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MISSING_MEDIA_PUBLISH_MESSAGE, MissingMediaError } from '@civitai/shared';

/**
 * The page action behind the ingestion-error queue.
 *
 * The refusal message is USER-FACING: the guard throws it deep in the service, and the only thing
 * that makes a moderator ever see it is this action turning the error into `fail(400, { error })`.
 * A guard whose message never reaches the screen leaves the moderator staring at a generic failure
 * and re-clicking, which is how the original defect stayed invisible.
 */

const resolveIngestionError = vi.fn();
const getIngestionErrorImages = vi.fn(async () => ({ items: [] }));

vi.mock('$lib/server/ingestion.service', () => ({
  resolveIngestionError,
  getIngestionErrorImages,
}));

const { actions: errorActions } = await import('../ingestion-errors/+page.server');

const request = (fields: Record<string, string>) =>
  ({
    formData: async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return form;
    },
  } as never);

const locals = { user: { id: 7 } } as never;

beforeEach(() => {
  // 🔴 reset, not clear. `clearAllMocks` clears CALLS, not IMPLEMENTATIONS, so a `mockRejectedValue`
  // from an earlier case leaks into every later one and a case that forgets to arm the service
  // passes for the wrong reason.
  vi.resetAllMocks();
});

describe('ingestion-errors resolve action', () => {
  it('renders the missing-media refusal to the moderator as a 400 carrying the message', async () => {
    resolveIngestionError.mockRejectedValue(new MissingMediaError());

    const result = (await errorActions.resolve({
      request: request({ id: '4242', nsfwLevel: '1' }),
      locals,
    } as never)) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toBe(MISSING_MEDIA_PUBLISH_MESSAGE);
  });

  it('still reports success for an image the guard allowed', async () => {
    resolveIngestionError.mockResolvedValue(undefined);

    const result = await errorActions.resolve({
      request: request({ id: '4242', nsfwLevel: '1' }),
      locals,
    } as never);

    expect(result).toEqual({ success: true, id: 4242, nsfwLevel: 1 });
  });

  it('offers no way to publish other than resolve', () => {
    // If a second action appeared on this page it would bypass the guard, which lives in
    // `resolveIngestionError` rather than in the route.
    expect(Object.keys(errorActions)).toEqual(['resolve']);
  });
});
