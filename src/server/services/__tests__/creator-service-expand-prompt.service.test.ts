import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  expandServiceDealPrompt,
  SERVICE_PROMPT_MODEL,
  SERVICE_PROMPT_REFUSED,
} from '~/server/services/creator-service-expand-prompt.service';

const SELLER = 7;
const classify = vi.fn();
const complete = vi.fn();
const audit = vi.fn();
const INSTRUCTIONS = 'Write one image prompt.';
const REQUEST = 'CivChan at the beach';
const deal = (over: Record<string, unknown> = {}) => ({
  sellerId: SELLER,
  status: 'Requested',
  heldAt: new Date(),
  requestText: REQUEST,
  ...over,
});
const expand = (sellerId = SELLER) =>
  expandServiceDealPrompt(
    {
      dealId: 1,
      sellerId,
      instructions: INSTRUCTIONS,
      token: 't',
      isGreen: true,
      isModerator: false,
      currencies: ['yellow'],
    },
    { classify, complete, audit }
  );

beforeEach(() => {
  classify.mockReset().mockResolvedValue({ outcome: 'pass', externalError: null });
  audit.mockReset().mockResolvedValue(undefined);
  complete.mockReset().mockResolvedValue({ content: 'a prompt', workflowId: 'w' });
  dbMock.dbWrite.serviceDeal.findUnique.mockResolvedValue(deal());
});

describe('expandServiceDealPrompt', () => {
  it("sends the deal's own request text to the service model and returns the prompt", async () => {
    await expect(expand()).resolves.toEqual({ prompt: 'a prompt' });
    const call = complete.mock.calls[0][0];
    expect(call.model).toBe(SERVICE_PROMPT_MODEL);
    expect(call.messages).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: REQUEST },
    ]);
    // Control for the refusal below: clean instructions were audited as the seller, then sent.
    expect(audit).toHaveBeenCalledExactlyOnceWith({
      prompt: INSTRUCTIONS,
      userId: SELLER,
      isGreen: true,
      isModerator: false,
    });
  });

  it("refuses the seller's instructions when the audit blocks them, before the model", async () => {
    audit.mockRejectedValue(new TRPCError({ code: 'BAD_REQUEST', message: 'blocked: word' }));
    await expect(expand()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: SERVICE_PROMPT_REFUSED,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('passes an unavailable audit through as retry-able, not as a refusal', async () => {
    audit.mockRejectedValue(new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'down' }));
    await expect(expand()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ['another seller', () => expand(SELLER + 1)],
    [
      'a deal past acceptance',
      () => (
        dbMock.dbWrite.serviceDeal.findUnique.mockResolvedValue(deal({ status: 'Delivered' })),
        expand()
      ),
    ],
    [
      'an unpaid deal',
      () => (
        dbMock.dbWrite.serviceDeal.findUnique.mockResolvedValue(deal({ heldAt: null })), expand()
      ),
    ],
  ])('refuses %s before any check or model call', async (_, run) => {
    await expect(run()).rejects.toThrow();
    expect(classify).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ['refused', { outcome: 'hard', externalError: null }, 'BAD_REQUEST'],
    ['soft-blocked', { outcome: 'soft', externalError: null }, 'BAD_REQUEST'],
    ['unchecked', { outcome: 'pass', externalError: { message: 'down' } }, 'SERVICE_UNAVAILABLE'],
  ])('a %s request never reaches the model', async (_, verdict, code) => {
    classify.mockResolvedValue(verdict);
    await expect(expand()).rejects.toMatchObject({ code });
    expect(complete).not.toHaveBeenCalled();
    // The buyer's text is only classified: the recording audit never sees it.
    expect(classify).toHaveBeenCalledWith({ prompt: REQUEST, isGreen: true });
    expect(audit.mock.calls.map(([o]) => o.prompt)).not.toContain(REQUEST);
  });

  it('fails rather than return a blank prompt', async () => {
    complete.mockResolvedValue({ content: '', workflowId: 'w' });
    await expect(expand()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});
