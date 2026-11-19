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

describe('an HTTP error', () => {
  it('logs and throws the status and error code without the response text', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { message: 'bad input: PROMPT_ECHO', code: 'invalid_request' } },
        { status: 400 }
      )
    );

    const error = await call().then(
      () => {
        throw new Error('expected the call to reject');
      },
      (e: Error) => e
    );

    expect(error.message).not.toContain('PROMPT_ECHO');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PROMPT_ECHO');
    expect(error.message).toMatch(/^Civitai LLM error 400: .*code=invalid_request/);
    expect(JSON.stringify(consoleError.mock.calls)).toContain('code=invalid_request');
  });
});

describe('a successful response whose body is not JSON', () => {
  it('logs and throws without the body', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(new Response('PROMPT_ECHO', { status: 200 }));

    const error = await call().then(
      () => {
        throw new Error('expected the call to reject');
      },
      (e: Error) => e
    );

    expect(error.message).not.toContain('PROMPT_ECHO');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PROMPT_ECHO');
    expect(error.message).toMatch(/^Civitai LLM error 200: /);
  });
});
