import { expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

envMock.set({ OPENAI_API_KEY: 'test-key' });
const { openai } = await import('~/server/services/ai/openai');

it('logs an unparseable completion without the model output', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  create.mockResolvedValue({ choices: [{ message: { content: 'PROMPT_ECHO not json' } }] });

  await expect(
    openai!.getJsonCompletion({ messages: [{ role: 'user', content: 'x' }] })
  ).rejects.toThrow('Failed to parse JSON block from completion');

  expect(consoleError).toHaveBeenCalled();
  expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PROMPT_ECHO');
});
