import { describe, expect, it } from 'vitest';
import { submitAdvisories } from '~/server/services/blocks/submit-advisories';

/**
 * `submitAdvisories` can neither fail nor hold up a submit: a read that throws, or one that never
 * settles, answers no advisory. (`publish-request.submitValidation.test.ts` covers what a real
 * bundle answers through `submitVersion`.)
 */
describe('submitAdvisories — warn, never block', () => {
  const bundle = Buffer.from('unused: the files are injected');
  const stock = new Map([['src/index.css', '.card { color: var(--civitai-color-text); }']]);

  it('CONTROL: the stock look answers the default-theme advisory', async () => {
    const advisories = await submitAdvisories(bundle, { files: async () => stock });
    expect(advisories.map((a) => a.code)).toEqual(['default-theme']);
  });

  it('a read that throws answers no advisory, without throwing', async () => {
    await expect(
      submitAdvisories(bundle, {
        files: async () => {
          throw new Error('corrupt zip');
        },
      })
    ).resolves.toEqual([]);
  });

  it('a read that never settles answers no advisory within its bound', async () => {
    const started = Date.now();
    await expect(
      submitAdvisories(bundle, { files: () => new Promise(() => undefined), timeoutMs: 50 })
    ).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a bundle with nothing to judge answers no advisory', async () => {
    await expect(
      submitAdvisories(bundle, { files: async () => new Map([['README.md', '# app']]) })
    ).resolves.toEqual([]);
  });
});
