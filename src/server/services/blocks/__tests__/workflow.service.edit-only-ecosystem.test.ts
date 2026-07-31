import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * The ECOSYSTEM-level half of the edit-only guard in
 * `resolveBlockImageWorkflowType`: an ecosystem that supports `img2img:edit`
 * but NOT `txt2img` cannot honour a body with no `sourceImage`.
 *
 * WHY THIS FILE IS SEPARATE, AND WHY IT MOCKS
 * ------------------------------------------
 * No image ecosystem is edit-only in the CURRENT config — every member of
 * `EDIT_IMG_IDS` is also in `TXT2IMG_IDS` (asserted below against the real
 * config). So the guard is unreachable today and there is no real ecosystem id
 * that exercises it. A guard nothing can make fail is a guard nobody has
 * tested, so rather than leave it unverified this file mocks ONLY
 * `isWorkflowAvailable` — the single function the guard consults — to stand up
 * the edit-only ecosystem the config does not currently contain.
 *
 * It lives in its own file because the mock is module-scoped and the rest of
 * the workflow.service suite deliberately runs against the REAL workflow config.
 */

const { availability } = vi.hoisted(() => ({
  // workflowId -> ecosystemId -> available
  availability: { map: new Map<string, boolean>() },
}));

vi.mock('~/shared/data-graph/generation/config/workflows', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('~/shared/data-graph/generation/config/workflows')
  >();
  return {
    ...actual,
    isWorkflowAvailable: (workflowId: string, ecosystemId: number) => {
      const override = availability.map.get(`${workflowId}|${ecosystemId}`);
      return override ?? actual.isWorkflowAvailable(workflowId, ecosystemId);
    },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: { modelVersion: { findUnique: vi.fn() } } }));

import { resolveBlockImageWorkflowType } from '../workflow.service';
import { ECO } from '~/shared/constants/basemodel.constants';

// A stand-in ecosystem id; the mock decides its capabilities.
const FAKE_ECO = 999001;

function setAvailability(entries: Record<string, boolean>) {
  availability.map.clear();
  for (const [key, value] of Object.entries(entries)) availability.map.set(key, value);
}

const bareBody = {
  kind: 'textToImage' as const,
  modelId: 7,
  modelVersionId: 99,
  params: { prompt: 'a cat', quantity: 1 },
};

describe('edit-only ECOSYSTEM + no sourceImage', () => {
  it('rejects a bare body on an ecosystem that supports img2img:edit but not txt2img', () => {
    setAvailability({
      [`txt2img|${FAKE_ECO}`]: false,
      [`img2img|${FAKE_ECO}`]: false,
      [`img2img:edit|${FAKE_ECO}`]: true,
    });
    let caught: unknown;
    try {
      resolveBlockImageWorkflowType(bareBody as never, FAKE_ECO);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
    expect((caught as TRPCError).message).toContain('edit-only');
    expect((caught as TRPCError).message).toContain('sourceImage');
  });

  it('still returns txt2img when the ecosystem supports BOTH', () => {
    setAvailability({
      [`txt2img|${FAKE_ECO}`]: true,
      [`img2img:edit|${FAKE_ECO}`]: true,
    });
    expect(resolveBlockImageWorkflowType(bareBody as never, FAKE_ECO)).toBe('txt2img');
  });

  it('still returns txt2img for a txt2img-only ecosystem', () => {
    setAvailability({
      [`txt2img|${FAKE_ECO}`]: true,
      [`img2img|${FAKE_ECO}`]: false,
      [`img2img:edit|${FAKE_ECO}`]: false,
    });
    expect(resolveBlockImageWorkflowType(bareBody as never, FAKE_ECO)).toBe('txt2img');
  });

  it('still returns txt2img when the ecosystem is unknown (ecosystemId omitted)', () => {
    setAvailability({});
    expect(resolveBlockImageWorkflowType(bareBody as never, undefined)).toBe('txt2img');
  });

  // The config invariant that makes the guard unreachable TODAY. If this ever
  // fails, an edit-only image ecosystem has shipped — the guard above is now
  // live traffic, not a future-proofing measure, and this file's mock stops
  // being the only way to exercise it.
  it('documents that no REAL image ecosystem is currently edit-only', async () => {
    setAvailability({});
    const { isWorkflowAvailable } = await import(
      '~/shared/data-graph/generation/config/workflows'
    );
    const editOnly = Object.values(ECO).filter(
      (id) =>
        typeof id === 'number' &&
        isWorkflowAvailable('img2img:edit', id) &&
        !isWorkflowAvailable('txt2img', id)
    );
    expect(editOnly).toEqual([]);
  });
});
