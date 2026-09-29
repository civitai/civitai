import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA' },
}));

import { mapDataToGraphInput } from '~/server/services/orchestrator/legacy-metadata-mapper';

/**
 * Pins the server-side host gate on meta-derived media URLs.
 *
 * `Image.meta` is attacker-writable: `imageMetaSchema` is a looseObject, so
 * stored `images`/`sourceImage` entries ride through unvalidated, and
 * `mapDataToGraphInput` is the one function that promotes them into form
 * values ("Reuse prompt & resources"). The form fetches source URLs
 * client-side, so a URL that is not a first-party media host must not be
 * handed over. Legit stored values are orchestrator blob URLs and the image
 * CDN — the same hosts pinned here, so the gate is behavior-preserving for
 * every legit producer. ClickUp 868maend5.
 */

const ORCHESTRATOR_BLOB_URL = 'https://orchestration.civitai.com/v1/consumer/blobs/abc?sig=s&exp=1';
const CDN_URL = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/00000-1/x.png';
const ATTACKER_URL = 'https://civitai.com/private-endpoint.png';
const FOREIGN_URL = 'https://evil.example/a.png';

describe('mapDataToGraphInput — meta URL host gate', () => {
  beforeEach(() => {
    loggingMock.logToAxiom.mockClear();
  });

  it('drops a foreign-host images array', () => {
    const out = mapDataToGraphInput(
      { prompt: 'p', images: [{ url: ATTACKER_URL, width: 1, height: 1 }] },
      []
    );
    expect(out.images).toBeUndefined();
  });

  it('drops a foreign-host sourceImage', () => {
    const out = mapDataToGraphInput(
      { prompt: 'p', sourceImage: { url: FOREIGN_URL, width: 1, height: 1 } },
      []
    );
    expect(out.images).toBeUndefined();
  });

  it('leaves images undefined when every entry is foreign', () => {
    const out = mapDataToGraphInput(
      {
        prompt: 'p',
        images: [
          { url: ATTACKER_URL, width: 1, height: 1 },
          { url: FOREIGN_URL, width: 1, height: 1 },
        ],
      },
      []
    );
    expect(out.images).toBeUndefined();
  });

  it('keeps first-party orchestrator blob URLs (behavior-preserving pin)', () => {
    const out = mapDataToGraphInput(
      { prompt: 'p', images: [{ url: ORCHESTRATOR_BLOB_URL, width: 1, height: 1 }] },
      []
    );
    expect(out.images).toEqual([{ url: ORCHESTRATOR_BLOB_URL, width: 1, height: 1 }]);
  });

  it('keeps a first-party sourceImage', () => {
    const out = mapDataToGraphInput(
      { prompt: 'p', sourceImage: { url: ORCHESTRATOR_BLOB_URL, width: 1, height: 1 } },
      []
    );
    expect(out.images).toEqual([{ url: ORCHESTRATOR_BLOB_URL, width: 1, height: 1 }]);
  });

  it('keeps the configured image CDN host', () => {
    const out = mapDataToGraphInput(
      { prompt: 'p', images: [{ url: CDN_URL, width: 1, height: 1 }] },
      []
    );
    expect(out.images).toEqual([{ url: CDN_URL, width: 1, height: 1 }]);
  });

  it('keeps every orchestration* first-party host', () => {
    const out = mapDataToGraphInput(
      {
        prompt: 'p',
        images: [
          { url: 'https://orchestration-new.civitai.com/v1/consumer/blobs/x', width: 1, height: 1 },
          {
            url: 'https://orchestration-next.civitai.com/v1/consumer/blobs/y',
            width: 1,
            height: 1,
          },
        ],
      },
      []
    );
    expect(out.images).toHaveLength(2);
  });

  it('drops non-https URLs even on a first-party host', () => {
    const out = mapDataToGraphInput(
      {
        prompt: 'p',
        images: [{ url: 'http://orchestration.civitai.com/x.png', width: 1, height: 1 }],
      },
      []
    );
    expect(out.images).toBeUndefined();
  });

  it('drops unparseable and non-string URL values', () => {
    const out = mapDataToGraphInput(
      {
        prompt: 'p',
        images: [
          { url: 'not a url', width: 1, height: 1 },
          { url: undefined, width: 1, height: 1 },
        ],
      },
      []
    );
    expect(out.images).toBeUndefined();
  });

  it('keeps a foreign-host entry among first-party ones (per-entry filter, not all-or-nothing)', () => {
    const out = mapDataToGraphInput(
      {
        prompt: 'p',
        images: [
          { url: ORCHESTRATOR_BLOB_URL, width: 1, height: 1 },
          { url: FOREIGN_URL, width: 2, height: 2 },
        ],
      },
      []
    );
    expect(out.images).toEqual([{ url: ORCHESTRATOR_BLOB_URL, width: 1, height: 1 }]);
  });

  it('logs each drop with the host only — never the full URL', async () => {
    const out = mapDataToGraphInput(
      { prompt: 'p', sourceImage: { url: `${ATTACKER_URL}?sig=secret`, width: 1, height: 1 } },
      []
    );
    expect(out.images).toBeUndefined();

    await vi.waitFor(() => {
      expect(loggingMock.logToAxiom).toHaveBeenCalled();
    });
    const logged = JSON.stringify(loggingMock.logToAxiom.mock.calls);
    expect(logged).toContain('civitai.com');
    expect(logged).not.toContain('private-endpoint');
    expect(logged).not.toContain('sig=secret');
  });
});
