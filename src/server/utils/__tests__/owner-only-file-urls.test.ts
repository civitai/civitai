import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';

import { resolveOwnerOnlyFileUrls, withoutFileUrls } from '~/server/utils/owner-only-file-urls';

/**
 * A model file's `url` is its storage location. These pin that only the version owner and moderators
 * get it back, and — the property the edge cache depends on — that the decision is made on the
 * RESOLVER'S OUTPUT per request, keyed on `ctx.user`, so no shared upstream can hand one viewer's
 * body to another. createContext gives any session edgeTTL 0 (never edge-cached) and anonymous
 * requests a positive TTL; an anonymous caller is never the owner, so a cached body is always stripped.
 */

const OWNER = 7;
const OTHER = 8;
const DATA = { files: [{ id: 1, url: 'model/7/a.safetensors' }] };

// A middleware built by ownerOnlyFileUrls, invoked the way tRPC invokes it: call next(), then it
// transforms the result. We drive it directly with a fake next() so no router graph has to load.
async function run(
  user: { id: number; isModerator: boolean } | undefined,
  { ownerUnknown = false }: { ownerUnknown?: boolean } = {}
) {
  // Fresh copy each call so a leaked mutation of the shared fixture can't make a later case pass.
  const data = { files: DATA.files.map((f) => ({ ...f })) };
  const resolved = await resolveOwnerOnlyFileUrls<typeof DATA, { id: number }>(
    {
      ownerId: () => (ownerUnknown ? undefined : OWNER),
      strip: (d) => ({ ...d, files: withoutFileUrls(d.files) as typeof d.files }),
    },
    { data, input: { id: 1 }, user }
  );
  return { data: resolved };
}

beforeEach(() => vi.clearAllMocks());

describe('ownerOnlyFileUrls', () => {
  it('keeps the url for the version owner', async () => {
    const result = await run({ id: OWNER, isModerator: false });
    expect(result.data.files[0].url).toBe('model/7/a.safetensors');
  });

  it('keeps the url for a moderator who is not the owner', async () => {
    const result = await run({ id: OTHER, isModerator: true });
    expect(result.data.files[0].url).toBe('model/7/a.safetensors');
  });

  it.each([
    ['a signed-in non-owner', { id: OTHER, isModerator: false }],
    ['an anonymous caller', undefined],
  ])('strips the url for %s', async (_label, user) => {
    const result = await run(user as never);
    expect(result.data.files[0].url).toBeUndefined();
    // Everything else about the file survives — only the url is removed.
    expect(result.data.files[0].id).toBe(1);
  });

  it('strips when the owner cannot be resolved (unknown version)', async () => {
    const result = await run({ id: OWNER, isModerator: false }, { ownerUnknown: true });
    expect(result.data.files[0].url).toBeUndefined();
  });
});

describe('withoutFileUrls', () => {
  it('passes through null/undefined untouched', () => {
    expect(withoutFileUrls(null)).toBeNull();
    expect(withoutFileUrls(undefined)).toBeUndefined();
  });
});
