import JSZip from 'jszip';
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

  it('a read that lands after the bound is not scanned', async () => {
    let iterated = 0;
    const counted = new Map(stock);
    const iterate = counted[Symbol.iterator].bind(counted);
    counted[Symbol.iterator] = () => {
      iterated++;
      return iterate();
    };
    await expect(
      submitAdvisories(bundle, {
        files: () => new Promise((resolve) => setTimeout(() => resolve(counted), 80)),
        timeoutMs: 10,
      })
    ).resolves.toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(iterated).toBe(0);
  });

  it('a small compressed bundle of adversarial sources is judged in linear time', async () => {
    // Highly compressible: the zip is a few KiB, its two sources just under the 512 KiB file cap.
    const size = 512 * 1024 - 1;
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const zip = new JSZip();
    zip.file('block.manifest.json', '{}');
    zip.file('src/a.js', fill('--civitai-a'));
    zip.file('src/b.js', fill('--civitai-'));
    zip.file('index.html', fill('<style '));
    const buffer = Buffer.from(
      await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    );
    expect(buffer.length).toBeLessThan(64 * 1024);
    const started = performance.now();
    // The real unzip and read (`bundleSignalFiles`), and a bound no slow machine reaches.
    const advisories = await submitAdvisories(buffer, { timeoutMs: 30_000 });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(advisories.map((a) => a.code)).toEqual(['default-theme']);
  });
});
