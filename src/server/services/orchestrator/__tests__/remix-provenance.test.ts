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

const { applyVerifiedProvenance, resolveSourceImageIds, signProvenance, verifyProvenance } =
  await import('~/server/services/orchestrator/remix-provenance');

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

describe('applyVerifiedProvenance', () => {
  it('writes the ids a valid token vouches for and drops the token itself', async () => {
    const provenance = signProvenance({ userId: 42, sourceImageIds: [7] });

    const meta = await applyVerifiedProvenance({
      meta: { prompt: 'cat', extra: { provenance, remixOfId: 7 } },
      userId: 42,
    });

    expect(meta.extra).toEqual({ remixOfId: 7, sourceImageIds: [7] });
    expect(getWorkflowMock).not.toHaveBeenCalled();
  });

  it('discards source ids the client supplied on its own', async () => {
    const meta = await applyVerifiedProvenance({
      meta: { extra: { sourceImageIds: [999], remixOfId: 999 } },
      userId: 42,
    });

    expect(meta.extra).toEqual({ remixOfId: 999 });
  });

  it('discards ids from a token that belongs to someone else', async () => {
    const provenance = signProvenance({ userId: 1, sourceImageIds: [7] });

    const meta = await applyVerifiedProvenance({
      meta: { extra: { provenance } },
      userId: 42,
    });

    expect(meta.extra).toEqual({});
  });

  it('falls back to the workflow the user owns when the file carries nothing', async () => {
    getWorkflowMock.mockResolvedValue({ metadata: { sourceImageIds: [11, 12] } });

    const meta = await applyVerifiedProvenance({
      meta: { prompt: 'cat' },
      userId: 42,
      generationWorkflowId: 'wf-1',
    });

    expect(meta.extra).toEqual({ sourceImageIds: [11, 12] });
    expect(getWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'token', path: { workflowId: 'wf-1' } })
    );
  });

  it('records nothing when the workflow is not the caller’s to read', async () => {
    getWorkflowMock.mockRejectedValue(new Error('not found'));

    const meta = await applyVerifiedProvenance({
      meta: { extra: { sourceImageIds: [999] } },
      userId: 42,
      generationWorkflowId: 'someone-elses-workflow',
    });

    expect(meta.extra).toEqual({});
  });

  it('leaves an ordinary upload untouched', async () => {
    const meta = { prompt: 'cat', extra: { remixOfId: 3 } };

    expect(await applyVerifiedProvenance({ meta, userId: 42 })).toBe(meta);
    expect(await applyVerifiedProvenance({ meta: null, userId: 42 })).toBeNull();
  });
});
