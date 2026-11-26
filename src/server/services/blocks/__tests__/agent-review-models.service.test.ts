import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAgentReviewModelOptions,
  getPickableAgentReviewModels,
  OPENROUTER_MODELS_URL,
  parseToolCapableModels,
  resolveAgentReviewModel,
} from '~/server/services/blocks/agent-review-models.service';

/**
 * The re-run model picker's source: OpenRouter's public model list, narrowed to tool-capable
 * models with a known price. Only the network is faked (global `fetch`).
 */

/** A trimmed OpenRouter `/api/v1/models` body: prices are USD per token, as decimal strings. */
const BODY = {
  data: [
    {
      id: 'zeta/tool-model',
      name: 'Zeta: Tool Model',
      context_length: 1_048_576,
      pricing: { prompt: '0.00000014', completion: '0.00000028' },
      supported_parameters: ['tools', 'tool_choice', 'response_format'],
    },
    {
      id: 'alpha/also-tools:free',
      name: 'Alpha: Also Tools (free)',
      context_length: 32_000,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['temperature', 'tools'],
    },
    // No tool support: excluded.
    {
      id: 'beta/no-tools',
      name: 'Beta: No Tools',
      context_length: 8_000,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      supported_parameters: ['temperature'],
    },
    // A router priced per request ("-1"): cannot be costed up front, excluded.
    {
      id: 'gamma/auto',
      name: 'Gamma: Auto',
      context_length: 2_000_000,
      pricing: { prompt: '-1', completion: '-1' },
      supported_parameters: ['tools'],
    },
    // An id outside the accepted shape (would not be dispatchable): excluded.
    {
      id: 'Delta/Upper Case',
      name: 'Delta',
      pricing: { prompt: '0.000001', completion: '0.000001' },
      supported_parameters: ['tools'],
    },
    // Malformed entries are skipped, never fatal.
    null,
    'nonsense',
    { id: 'eps/no-pricing', supported_parameters: ['tools'] },
  ],
};

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  getAgentReviewModelOptions.clear();
  fetchMock = vi.fn(async () => okResponse(BODY));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('parseToolCapableModels', () => {
  it('keeps only tool-capable, priced, well-formed models, in the picker shape, sorted by name', () => {
    expect(parseToolCapableModels(BODY)).toEqual([
      {
        id: 'alpha/also-tools:free',
        name: 'Alpha: Also Tools (free)',
        promptPerM: 0,
        completionPerM: 0,
      },
      {
        id: 'zeta/tool-model',
        name: 'Zeta: Tool Model',
        // Per token → per million, without float noise (0.13999999999999999).
        promptPerM: 0.14,
        completionPerM: 0.28,
      },
    ]);
  });

  it('a body that is not a model list yields an empty list, not a throw', () => {
    expect(parseToolCapableModels(null)).toEqual([]);
    expect(parseToolCapableModels({ data: 'x' })).toEqual([]);
  });
});

describe('getAgentReviewModelOptions', () => {
  it('fetches the public list once and serves the cached copy after that', async () => {
    const first = await getAgentReviewModelOptions();
    const second = await getAgentReviewModelOptions();
    expect(first.map((m) => m.id)).toEqual(['alpha/also-tools:free', 'zeta/tool-model']);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(OPENROUTER_MODELS_URL);
  });

  it('a failed fetch rejects and caches nothing: the next call fetches again', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response);
    await expect(getAgentReviewModelOptions()).rejects.toThrow(/503/);
    await expect(getAgentReviewModelOptions()).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a list with no tool-capable models is treated as broken, not cached as "none"', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: [] }));
    await expect(getAgentReviewModelOptions()).rejects.toThrow();
    await expect(getAgentReviewModelOptions()).resolves.toHaveLength(2);
  });
});

/**
 * The input-price ceiling ($5 per million input tokens). A body with one model exactly AT it and
 * one just above, so an off-by-one (`<` for `<=`) and a missing check both show.
 */
const CEILING_BODY = {
  data: [
    {
      id: 'acme/at-ceiling',
      name: 'Acme: At Ceiling',
      pricing: { prompt: '0.000005', completion: '0.000025' },
      supported_parameters: ['tools'],
    },
    {
      id: 'acme/above-ceiling',
      name: 'Acme: Above Ceiling',
      pricing: { prompt: '0.00000501', completion: '0.000025' },
      supported_parameters: ['tools'],
    },
    {
      id: 'acme/premium',
      name: 'Acme: Premium',
      pricing: { prompt: '0.000015', completion: '0.000075' },
      supported_parameters: ['tools'],
    },
  ],
};

describe('input-price ceiling', () => {
  beforeEach(() => fetchMock.mockImplementation(async () => okResponse(CEILING_BODY)));

  it('a model at exactly $5/M input is allowed (listed and accepted)', async () => {
    await expect(resolveAgentReviewModel('acme/at-ceiling')).resolves.toMatchObject({
      id: 'acme/at-ceiling',
      promptPerM: 5,
    });
    expect((await getPickableAgentReviewModels()).map((m) => m.id)).toEqual(['acme/at-ceiling']);
  });

  it.each(['acme/above-ceiling', 'acme/premium'])(
    '🔴 %s (input price above the ceiling) is refused at the server, naming the limit',
    async (id) => {
      await expect(resolveAgentReviewModel(id)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('above the $5 limit'),
      });
    }
  );
});

describe('resolveAgentReviewModel', () => {
  it('returns the listed entry, with its price', async () => {
    await expect(resolveAgentReviewModel('zeta/tool-model')).resolves.toMatchObject({
      id: 'zeta/tool-model',
      promptPerM: 0.14,
      completionPerM: 0.28,
    });
  });

  it('refuses a model OpenRouter does not list as tool-capable', async () => {
    await expect(resolveAgentReviewModel('beta/no-tools')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('refuses (rather than running unpriced) when the list cannot be fetched', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(resolveAgentReviewModel('zeta/tool-model')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/cost cap/),
    });
  });
});
