import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  expandServiceDealPrompt,
  SERVICE_PROMPT_MODEL,
} from '~/server/services/creator-service-expand-prompt.service';

const SELLER = 7;
const classify = vi.fn();
const complete = vi.fn();
const deal = (over: Record<string, unknown> = {}) => ({
  sellerId: SELLER,
  status: 'Requested',
  heldAt: new Date(),
  requestText: 'CivChan at the beach',
  ...over,
});
const expand = (sellerId = SELLER) =>
  expandServiceDealPrompt(
    {
      dealId: 1,
      sellerId,
      instructions: 'Write one image prompt.',
      token: 't',
      isGreen: true,
      currencies: ['yellow'],
    },
    { classify, complete }
  );

beforeEach(() => {
  classify.mockReset().mockResolvedValue({ outcome: 'pass', externalError: null });
  complete.mockReset().mockResolvedValue({ content: 'a prompt', workflowId: 'w' });
  dbMock.dbWrite.serviceDeal.findUnique.mockResolvedValue(deal());
});

describe('expandServiceDealPrompt', () => {
  it("sends the deal's own request text to the service model and returns the prompt", async () => {
    await expect(expand()).resolves.toEqual({ prompt: 'a prompt' });
    const call = complete.mock.calls[0][0];
    expect(call.model).toBe(SERVICE_PROMPT_MODEL);
    expect(call.messages.at(-1)).toEqual({ role: 'user', content: 'CivChan at the beach' });
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
  });

  it('fails rather than return a blank prompt', async () => {
    complete.mockResolvedValue({ content: '', workflowId: 'w' });
    await expect(expand()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});
