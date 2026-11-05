import { afterEach, describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';

envMock.set({
  ORCHESTRATOR_ENDPOINT: 'https://orchestrator.test',
  ORCHESTRATOR_ACCESS_TOKEN: 'test-token',
});
global.globalCivitaiLLM = undefined;
const { civitaiLLM } = await import('~/server/services/ai/civitai-llm');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

const call = () =>
  civitaiLLM!.getJsonCompletion({
    model: 'civitai/test-model',
    messages: [{ role: 'user', content: 'x' }],
  });

describe('an unparseable completion', () => {
  it('logs the failure without the model output', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'PROMPT_ECHO not json' } }],
      })
    );

    await expect(call()).rejects.toThrow('Failed to parse JSON from Civitai LLM completion');

    expect(consoleError).toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PROMPT_ECHO');
  });
});
