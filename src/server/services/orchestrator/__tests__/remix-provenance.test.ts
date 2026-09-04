import { createCipheriv, createHash, randomBytes } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbClient from '~/server/db/client';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const findMany = vi.fn();
const getWorkflowMock = vi.fn();
const getTokenMock = vi.fn();

vi.mock('~/server/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof DbClient>()),
  dbRead: { image: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: (...args: unknown[]) => getWorkflowMock(...args),
}));

vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: (...args: unknown[]) => getTokenMock(...args),
}));

vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA' },
}));

const {
  resolveSourceImageIds,
  resolveVerifiedSourceImageIds,
  sanitizeProvenance,
  signProvenance,
  storedSourceImageIds,
  unionSourceImageIds,
  verifyProvenance,
} = await import('~/server/services/orchestrator/remix-provenance');

const UUID_A = '11111111-2222-3333-4444-555555555555';
const IMAGE_HOST = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA';
const edgeUrl = (uuid: string) => `${IMAGE_HOST}/${uuid}/original=true/foo.jpeg`;

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  getTokenMock.mockResolvedValue('token');
});

describe('resolveSourceImageIds', () => {
  it('maps edge urls back to the image rows they came from', async () => {
    findMany.mockResolvedValue([{ id: 7, url: UUID_A }]);

    const ids = await resolveSourceImageIds([edgeUrl(UUID_A)]);

    expect(ids).toEqual([7]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { url: { in: [UUID_A] } } })
    );
  });

  it('takes the oldest row when several images share a url', async () => {
    findMany.mockResolvedValue([
      { id: 4, url: UUID_A },
      { id: 9, url: UUID_A },
    ]);

    expect(await resolveSourceImageIds([edgeUrl(UUID_A)])).toEqual([4]);
  });

  it('resolves nothing for inputs that are not on-site images', async () => {
    const ids = await resolveSourceImageIds([
      'https://orchestration.civitai.com/v2/consumer/blobs/ABCDEF.jpeg',
      'https://example.com/cat.png',
    ]);

    expect(ids).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('refuses a uuid that did not arrive on our image host', async () => {
    // Input image URLs are a bare `z.string()`, so the uuid alone proves nothing
    // about whose bytes the job actually read. The bare-uuid form is refused for
    // the same reason: accepting it would rest on the orchestrator declining to
    // fetch it, which is exactly the assumption the host check removes.
    expect(await resolveSourceImageIds([`https://attacker.example/${UUID_A}/x.png`])).toEqual([]);
    expect(await resolveSourceImageIds([UUID_A])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

/** Mints a token with a chosen issue time, the way the real signer would. */
function tokenIssuedAt(seconds: number, userId = 42, sourceImageIds = [7]) {
  const key = createHash('sha256').update('test-secret:remix-provenance:v1').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ v: 1, u: userId, s: sourceImageIds, t: seconds }), 'utf8'),
    cipher.final(),
  ]);
  return [
    'p1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

describe('signProvenance / verifyProvenance', () => {
  it('round-trips the ids it was issued for', () => {
    const token = signProvenance({ userId: 42, sourceImageIds: [7, 8] });
    expect(verifyProvenance(token, 42)).toEqual([7, 8]);
  });

  it('refuses a token issued to a different user', () => {
    const token = signProvenance({ userId: 42, sourceImageIds: [7] });
    expect(verifyProvenance(token, 43)).toBeNull();
  });

  it('tells nobody who generated what', () => {
    // The token ships inside every generated file, and those are public. A
    // readable payload would publish the user id and the source image ids,
    // including sources that are private or unpublished.
    const token = signProvenance({ userId: 4242, sourceImageIds: [1337] })!;

    expect(token).not.toContain('4242');
    expect(token).not.toContain('1337');
    for (const part of token.split('.').slice(1))
      expect(Buffer.from(part, 'base64url').toString('utf8')).not.toContain('"u"');
  });

  it('refuses a payload edited after issue', () => {
    const token = signProvenance({ userId: 42, sourceImageIds: [7] })!;
    const [prefix, iv, ciphertext, tag] = token.split('.');
    const bytes = Buffer.from(ciphertext, 'base64url');
    bytes[0] ^= 0xff;

    expect(
      verifyProvenance([prefix, iv, bytes.toString('base64url'), tag].join('.'), 42)
    ).toBeNull();
  });

  it('refuses anything that is not one of our tokens', () => {
    for (const value of ['', 'nonsense', 'a.b', 'p1.a.b.c', undefined, null, 12, { s: [1] }])
      expect(verifyProvenance(value, 42)).toBeNull();
  });

  it('issues nothing when there are no source images', () => {
    expect(signProvenance({ userId: 42, sourceImageIds: [] })).toBeUndefined();
  });

  it('refuses a token past its lifetime, so one generation is not a permanent licence', () => {
    const past = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 31;

    expect(verifyProvenance(tokenIssuedAt(past), 42)).toBeNull();
  });

  it('refuses a token dated in the future', () => {
    expect(verifyProvenance(tokenIssuedAt(Math.floor(Date.now() / 1000) + 600), 42)).toBeNull();
  });

  it('accepts one issued inside the window (control for the two above)', () => {
    const recent = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 29;

    expect(verifyProvenance(tokenIssuedAt(recent), 42)).toEqual([7]);
  });
});

describe('resolveVerifiedSourceImageIds', () => {
  it('takes the ids a valid token vouches for without reading the workflow', async () => {
    const provenance = signProvenance({ userId: 42, sourceImageIds: [7] });

    expect(await resolveVerifiedSourceImageIds({ userId: 42, provenance })).toEqual([7]);
    expect(getWorkflowMock).not.toHaveBeenCalled();
  });

  it('refuses a token that belongs to someone else', async () => {
    const provenance = signProvenance({ userId: 1, sourceImageIds: [7] });

    expect(await resolveVerifiedSourceImageIds({ userId: 42, provenance })).toBeNull();
  });

  it('falls back to the workflow, read with the caller’s own token', async () => {
    getWorkflowMock.mockResolvedValue({
      metadata: { provenance: signProvenance({ userId: 42, sourceImageIds: [11, 12] }) },
    });

    expect(await resolveVerifiedSourceImageIds({ userId: 42, workflowId: 'wf-1' })).toEqual([
      11, 12,
    ]);
    expect(getTokenMock).toHaveBeenCalledWith(42, expect.anything());
    expect(getWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'token', path: { workflowId: 'wf-1' } })
    );
  });

  it('refuses ids a user wrote onto their own workflow', async () => {
    // `orchestrator.updateWorkflow` and `orchestrator.patch` accept free-form
    // metadata on a workflow the caller owns, so the metadata is attacker-
    // controlled. Only a signature we minted counts.
    getWorkflowMock.mockResolvedValue({
      metadata: { sourceImageIds: [999], provenance: 'forged' },
    });

    expect(await resolveVerifiedSourceImageIds({ userId: 42, workflowId: 'wf-1' })).toBeNull();
  });

  it('resolves nothing when the workflow is not the caller’s to read', async () => {
    getWorkflowMock.mockRejectedValue(new Error('not found'));

    expect(
      await resolveVerifiedSourceImageIds({ userId: 42, workflowId: 'someone-elses-workflow' })
    ).toBeNull();
  });
});

describe('sanitizeProvenance', () => {
  it('writes the verified ids and drops the token that proved them', () => {
    const meta = sanitizeProvenance({ prompt: 'cat', extra: { provenance: 'tok', remixOfId: 7 } }, [
      7,
    ]);

    expect(meta.extra).toEqual({ remixOfId: 7, sourceImageIds: [7] });
  });

  it('discards source ids nothing verified — the whole forgery surface', () => {
    // A user editing their own image's meta, or any write path that never proved
    // anything, must not be able to assert a derivation.
    expect(sanitizeProvenance({ extra: { sourceImageIds: [999], remixOfId: 999 } }).extra).toEqual({
      remixOfId: 999,
    });
    expect(sanitizeProvenance({ extra: { sourceImageIds: [999] } }, null).extra).toEqual({});
    expect(sanitizeProvenance({ extra: { sourceImageIds: [999] } }, []).extra).toEqual({});
  });

  it('keeps the ids already verified on the row when meta is edited', () => {
    const stored = storedSourceImageIds({ extra: { sourceImageIds: [7] } });

    expect(
      sanitizeProvenance({ prompt: 'edited', extra: { sourceImageIds: [999] } }, stored).extra
    ).toEqual({ sourceImageIds: [7] });
  });

  it('reads nothing off a row that never had a verified link', () => {
    expect(storedSourceImageIds(null)).toBeNull();
    expect(storedSourceImageIds({ extra: {} })).toBeNull();
    expect(storedSourceImageIds({ extra: { sourceImageIds: ['7'] } })).toBeNull();
  });

  it('leaves an ordinary upload untouched', () => {
    const meta = { prompt: 'cat', extra: { remixOfId: 3 } };

    expect(sanitizeProvenance(meta)).toBe(meta);
    expect(sanitizeProvenance(null)).toBeNull();
  });
});

describe('unionSourceImageIds', () => {
  const USER = 42;

  // Every token here is `mint`: the submit path accepts only tokens the mint
  // issued, so a `job` token would (correctly) contribute nothing.

  /**
   * The bug this exists for. A remix seeds an on-site URL, the generation form
   * re-uploads it as an orchestrator blob, and by submit time the URL route can
   * resolve nothing — so before the token route, a remix through the Animate
   * button recorded no derivation at all.
   */
  it('recovers the link when the url route found nothing', () => {
    const token = signProvenance({ userId: USER, sourceImageIds: [7], kind: 'mint' });

    expect(unionSourceImageIds({ urlSourceImageIds: [], tokens: [token!], userId: USER })).toEqual([
      7,
    ]);
  });

  it('keeps url-derived ids when there is no token', () => {
    expect(unionSourceImageIds({ urlSourceImageIds: [7, 8], userId: USER })).toEqual([7, 8]);
  });

  it('does not double-count an image both routes name', () => {
    const token = signProvenance({ userId: USER, sourceImageIds: [7], kind: 'mint' });

    expect(
      unionSourceImageIds({ urlSourceImageIds: [7, 9], tokens: [token!], userId: USER })
    ).toEqual([7, 9]);
  });

  /**
   * Each route caps itself at MAX_SOURCE_IMAGES, so a union of two full sets is
   * twice the bound unless the union re-applies it.
   */
  it('bounds the union, not just each route', () => {
    // Six plus four is ten. Deliberately NOT eight-plus-anything: with a full url
    // set the cap is satisfied by the url ids alone, so the assertion would hold
    // even if tokens were ignored entirely and the test could not fail.
    const urlSourceImageIds = [1, 2, 3, 4, 5, 6];
    const token = signProvenance({ userId: USER, sourceImageIds: [101, 102, 103, 104], kind: 'mint' });

    const ids = unionSourceImageIds({ urlSourceImageIds, tokens: [token!], userId: USER });

    expect(ids).toHaveLength(8);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 101, 102]);
  });

  /**
   * The whole reason this is a sealed token and not an id in the request body:
   * `sourceImageIds` gates the FREE remix-gallery submission, so a token minted
   * for someone else must buy nothing.
   */
  it('ignores a token issued to a different user', () => {
    const token = signProvenance({ userId: USER + 1, sourceImageIds: [7], kind: 'mint' });

    expect(unionSourceImageIds({ urlSourceImageIds: [], tokens: [token!], userId: USER })).toEqual(
      []
    );
  });

  it('treats an unreadable token as no signal rather than an error', () => {
    expect(
      unionSourceImageIds({
        urlSourceImageIds: [9],
        tokens: ['not-a-token', '', 'p1.a.b.c'],
        userId: USER,
      })
    ).toEqual([9]);
  });
});

/**
 * The audience split. `sourceImageIds` gates the FREE remix-gallery submission
 * and the `derivedFromHost` badge, and the upload path takes its token from
 * client-supplied `meta.extra.provenance` — so a token that cost no generation
 * must not be spendable there. These four assertions are the fix; without the
 * `k` check every one of them inverts.
 */
describe('provenance kind separates the mint from a real job', () => {
  const USER = 42;

  it('refuses a mint token on the upload path', async () => {
    const minted = signProvenance({ userId: USER, sourceImageIds: [7], kind: 'mint' })!;

    expect(verifyProvenance(minted, USER)).toBeNull();
    expect(await resolveVerifiedSourceImageIds({ userId: USER, provenance: minted })).toBeNull();
  });

  it('accepts a mint token on the submit path', () => {
    const minted = signProvenance({ userId: USER, sourceImageIds: [7], kind: 'mint' })!;

    expect(unionSourceImageIds({ urlSourceImageIds: [], tokens: [minted], userId: USER })).toEqual([
      7,
    ]);
  });

  /**
   * The other direction, and the reason the submit path does not simply accept
   * anything that verifies: a job token fed back in as a submit input would be
   * re-signed with a fresh timestamp, renewing its own 30-day expiry for as long
   * as the holder keeps submitting.
   */
  it('refuses a job token presented as a submit input', () => {
    const job = signProvenance({ userId: USER, sourceImageIds: [7] })!;

    expect(unionSourceImageIds({ urlSourceImageIds: [], tokens: [job], userId: USER })).toEqual([]);
  });

  /**
   * Tokens minted before `k` existed are baked into output files that live for
   * 30 days. They carry no `k` and must keep working on the path they were
   * issued for, which is why absent means `job` rather than being rejected.
   */
  it('treats a token with no kind as a job token', async () => {
    const legacy = signProvenance({ userId: USER, sourceImageIds: [7] })!;

    expect(verifyProvenance(legacy, USER)).toEqual([7]);
    expect(await resolveVerifiedSourceImageIds({ userId: USER, provenance: legacy })).toEqual([7]);
  });
});
