import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbClient from '~/server/db/client';
import type * as Workflows from '~/server/services/orchestrator/workflows';

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

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(() => Promise.resolve()),
}));

const {
  resolveSourceImageIds,
  resolveVerifiedSourceImageIds,
  sanitizeProvenance,
  signProvenance,
  storedSourceImageIds,
  verifyProvenance,
} = await import('~/server/services/orchestrator/remix-provenance');

const UUID_A = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  getTokenMock.mockResolvedValue('token');
});

describe('resolveSourceImageIds', () => {
  it('maps edge urls back to the image rows they came from', async () => {
    findMany.mockResolvedValue([{ id: 7, url: UUID_A }]);

    const ids = await resolveSourceImageIds([
      `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${UUID_A}/original=true/foo.jpeg`,
    ]);

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

    expect(await resolveSourceImageIds([UUID_A])).toEqual([4]);
  });

  it('resolves nothing for inputs that are not on-site images', async () => {
    const ids = await resolveSourceImageIds([
      'https://orchestration.civitai.com/v2/consumer/blobs/ABCDEF.jpeg',
      'https://example.com/cat.png',
    ]);

    expect(ids).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('signProvenance / verifyProvenance', () => {
  it('round-trips the ids it was issued for', () => {
    const token = signProvenance({ userId: 42, sourceImageIds: [7, 8] });
    expect(verifyProvenance(token, 42)).toEqual([7, 8]);
  });

  it('refuses a token issued to a different user', () => {
    const token = signProvenance({ userId: 42, sourceImageIds: [7] });
    expect(verifyProvenance(token, 43)).toBeNull();
  });

  it('refuses a payload edited after signing', () => {
    const token = signProvenance({ userId: 42, sourceImageIds: [7] })!;
    const [, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, u: 42, s: [999], t: 0 })).toString(
      'base64url'
    );

    expect(verifyProvenance(`${forged}.${signature}`, 42)).toBeNull();
  });

  it('refuses anything that is not one of our tokens', () => {
    for (const value of ['', 'nonsense', 'a.b', undefined, null, 12, { s: [1] }])
      expect(verifyProvenance(value, 42)).toBeNull();
  });

  it('issues nothing when there are no source images', () => {
    expect(signProvenance({ userId: 42, sourceImageIds: [] })).toBeUndefined();
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
    getWorkflowMock.mockResolvedValue({ metadata: { sourceImageIds: [11, 12] } });

    expect(await resolveVerifiedSourceImageIds({ userId: 42, workflowId: 'wf-1' })).toEqual([
      11, 12,
    ]);
    expect(getTokenMock).toHaveBeenCalledWith(42, expect.anything());
    expect(getWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'token', path: { workflowId: 'wf-1' } })
    );
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
