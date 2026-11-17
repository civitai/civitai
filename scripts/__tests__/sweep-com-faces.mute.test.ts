import { afterEach, expect, it, vi } from 'vitest';

// Stands in for the env files, which set LOGGING only when this module loads.
vi.mock('~/env/server', () => {
  process.env.LOGGING = 'prisma-showparams';
  return {};
});

import { assertNoPrismaLogging, muteAxiomEcho } from '../oneoffs/sweep-com-faces';

const original = console.log;
afterEach(() => {
  console.log = original;
});

// The echo as packages/civitai-axiom/src/client.ts writes it outside production (how `tsscript`
// runs); the vitest setup keeps the real logger from echoing, so it is reproduced here.
it("keeps the services' log echo, model id and error text, off stdout", () => {
  const printed = vi.fn();
  console.log = printed;
  const muted = muteAxiomEcho();
  console.log('logToAxiom', {
    name: 'model-com-face-intent',
    message: 'lock not added',
    modelId: 4242,
  });
  console.log('logToAxiom', { name: 'model-com-face-intent', message: 'upstream 503 for 4242' });
  console.log({ counts: 1 });

  expect(JSON.stringify(printed.mock.calls)).not.toContain('4242');
  expect(printed).toHaveBeenCalledWith({ counts: 1 });
  expect(muted).toEqual({
    'model-com-face-intent: lock not added': 1,
    'model-com-face-intent: other': 1,
  });
});

it('refuses a prisma LOGGING entry that only the env files set', async () => {
  delete process.env.LOGGING;
  await expect(assertNoPrismaLogging()).rejects.toThrow('LOGGING');
  delete process.env.LOGGING;
});
