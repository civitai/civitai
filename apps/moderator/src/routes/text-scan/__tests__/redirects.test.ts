import { describe, expect, it } from 'vitest';
import { load as rootLoad } from '../+page.server';
import { load as checkLoad } from '../check/+page.server';
import { load as playgroundLoad } from '../playground/+page.server';

const at = (path: string) => ({ url: new URL(`http://x${path}`) } as never);
const redirectsTo = (run: () => unknown, location: string) =>
  expect(Promise.resolve().then(run)).rejects.toMatchObject({ status: 307, location });

describe('text-scan redirects', () => {
  it('sends the group path and the playground to Prompts', async () => {
    await redirectsTo(() => rootLoad(at('/text-scan')), '/text-scan/prompts');
    await redirectsTo(() => playgroundLoad(at('/text-scan/playground')), '/text-scan/prompts');
  });

  it('sends Check to Prompts, keeping a valid key', async () => {
    await redirectsTo(
      () => checkLoad(at('/text-scan/check?key=label:scam')),
      '/text-scan/prompts?key=label%3Ascam'
    );
    await redirectsTo(() => checkLoad(at('/text-scan/check?key=nope')), '/text-scan/prompts');
    await redirectsTo(() => checkLoad(at('/text-scan/check')), '/text-scan/prompts');
  });
});
