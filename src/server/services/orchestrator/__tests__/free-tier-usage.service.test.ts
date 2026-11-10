import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFreeTier } from '@civitai/orchestration-client';
import { dbMock } from '~/__tests__/mocks/db.mock';

const h = vi.hoisted(() => ({ getOrchestratorToken: vi.fn() }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: h.getOrchestratorToken,
}));

import {
  getMyOrchestrationFreeUsage,
  timeSpanSeconds,
} from '~/server/services/orchestrator/free-tier-usage.service';

const USER = { id: 42 } as never;
const AIR = 'urn:air:qwen3:checkpoint:civitai:900@901';
// The shared client mock (src/__tests__/setup.ts) keeps Air.parseSafe verbatim, so AIR labels run real parsing.
const freeTierMock = vi.mocked(getFreeTier);
const freeTier = (data: unknown) =>
  freeTierMock.mockResolvedValue({ data, error: undefined } as never);

beforeEach(() => {
  h.getOrchestratorToken.mockReset().mockResolvedValue('tok');
  freeTierMock.mockReset();
  dbMock.dbRead.modelVersion.findMany
    .mockReset()
    .mockResolvedValue([{ id: 901, model: { name: 'Qwen 3.8' } }] as never);
});

describe('getMyOrchestrationFreeUsage', () => {
  it('shows no rows while the free tier is off, even for a model it still lists', async () => {
    freeTier({
      enabled: false,
      models: [
        {
          key: 'qwen3.8-chat',
          airs: [AIR],
          remaining: 200,
          windows: [{ duration: '1.00:00:00', limit: 200, remaining: 200, resetAt: null }],
        },
      ],
    });
    expect(await getMyOrchestrationFreeUsage(USER)).toEqual([]);
  });

  it('one row per window, named after the model behind its AIR, used counted from what is left', async () => {
    freeTier({
      enabled: true,
      models: [
        {
          key: 'qwen3.8-chat',
          airs: [AIR],
          remaining: 0,
          windows: [
            { duration: '1.00:00:00', limit: 200, remaining: 0, resetAt: '2026-11-10T08:12:00Z' },
            { duration: '01:00:00', limit: 20, remaining: 20, resetAt: null },
          ],
        },
        {
          key: 'mystery-bucket',
          airs: ['urn:air:sd1:checkpoint:huggingface:mystery@123'],
          remaining: 5,
          windows: [{ duration: '7.00:00:00', limit: 5, remaining: 5 }],
        },
      ],
    });
    const rows = await getMyOrchestrationFreeUsage(USER);
    expect(rows).toEqual([
      expect.objectContaining({
        label: 'Qwen 3.8, free per day',
        limit: 200,
        used: 200,
        remaining: 0,
        windowSeconds: 86400,
        nextAt: '2026-11-10T08:12:00Z',
        resetAt: '2026-11-10T08:12:00Z',
      }),
      expect.objectContaining({
        label: 'Qwen 3.8, free per hour',
        used: 0,
        nextAt: null,
        resetAt: null,
      }),
      // No civitai AIR to name it by: the bucket key stands in.
      expect.objectContaining({ label: 'mystery-bucket, free per week', used: 0 }),
    ]);
  });

  it('gives null, not an error, when the orchestrator will not issue this account a token', async () => {
    h.getOrchestratorToken.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    expect(await getMyOrchestrationFreeUsage(USER)).toBeNull();
    expect(freeTierMock).not.toHaveBeenCalled();
  });

  it('an unused window shows no reset time, though the orchestrator sends one', async () => {
    freeTier({
      enabled: true,
      models: [
        {
          key: 'qwen3.8-chat',
          airs: [AIR],
          remaining: 200,
          windows: [
            { duration: '1.00:00:00', limit: 200, remaining: 200, resetAt: '2026-11-10T08:12:00Z' },
            { duration: '01:00:00', limit: 20, remaining: 15, resetAt: '2026-11-09T22:00:00Z' },
          ],
        },
      ],
    });
    const rows = await getMyOrchestrationFreeUsage(USER);
    expect(rows?.map((r) => r.resetAt)).toEqual([null, '2026-11-09T22:00:00Z']);
  });

  it('a failure to get a token, other than a refusal, is an error, not "no free tier"', async () => {
    h.getOrchestratorToken.mockRejectedValue(new Error('redis down'));
    await expect(getMyOrchestrationFreeUsage(USER)).rejects.toThrow('redis down');
  });

  it('an orchestrator error is an error, not "free tier is off"', async () => {
    freeTierMock.mockResolvedValue({ data: undefined, error: { status: 503 } } as never);
    await expect(getMyOrchestrationFreeUsage(USER)).rejects.toThrow();
  });
});

describe('timeSpanSeconds', () => {
  it('reads the orchestrator TimeSpan forms, and refuses anything else', () => {
    expect(timeSpanSeconds('1.00:00:00')).toBe(86400);
    expect(timeSpanSeconds('01:30:00')).toBe(5400);
    expect(timeSpanSeconds('P1D')).toBeNull();
  });
});
