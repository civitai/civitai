import { describe, expect, it, vi } from 'vitest';

vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA' },
}));

import {
  decodeGenerationHandoff,
  encodeGenerationHandoff,
} from '~/components/generation_v2/utils/generation-url-handoff';

/**
 * Pins the `?gen=` handoff seam.
 *
 * The handoff payload is attacker-controlled input (any crafted
 * `civitai.com/generate?gen=<base64>` link); `decodeGenerationHandoff` is the
 * seam where it enters the generator, and the form auto-fetches source image
 * URLs client-side. Decoding must stay permissive for everything else (it is
 * a cross-domain form snapshot, so unknown keys are by design), but
 * media-URL-valued keys (`images`, `sourceImage`) are host-gated the same way
 * the server's meta propagation is: first-party hosts survive, foreign hosts
 * are stripped. ClickUp 868maend5.
 */

function encodePayload(params: Record<string, unknown>) {
  // `encodeGenerationHandoff` takes the flat form snapshot; `images`/`sourceImage`
  // ride through it unhoisted, which is exactly how a handoff link carries them.
  return encodeGenerationHandoff(params) as string;
}

describe('generation-url-handoff — media URL host gate', () => {
  it('stays permissive for non-URL params (handoff remains a full form snapshot)', () => {
    const decoded = decodeGenerationHandoff(encodePayload({ prompt: 'a cat', cfgScale: 7, someUnknownKey: 'x' }));
    expect(decoded?.params).toMatchObject({ prompt: 'a cat', cfgScale: 7, someUnknownKey: 'x' });
  });

  it('strips foreign-host images from the payload', () => {
    const decoded = decodeGenerationHandoff(
      encodePayload({
        prompt: 'p',
        images: [{ url: 'https://civitai.com/x.png', width: 1, height: 1 }],
      })
    );
    expect(decoded?.params.images).toBeUndefined();
  });

  it('strips a foreign-host sourceImage from the payload', () => {
    const decoded = decodeGenerationHandoff(
      encodePayload({ sourceImage: { url: 'https://evil.example/a.png', width: 1, height: 1 } })
    );
    expect(decoded?.params.sourceImage).toBeUndefined();
  });

  it('keeps first-party orchestrator blob URLs', () => {
    const url = 'https://orchestration.civitai.com/v1/consumer/blobs/abc?sig=s&exp=1';
    const decoded = decodeGenerationHandoff(encodePayload({ images: [{ url, width: 1, height: 1 }] }));
    expect(decoded?.params.images).toEqual([{ url, width: 1, height: 1 }]);
  });

  it('keeps the configured image CDN host', () => {
    const url = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/00000-1/x.png';
    const decoded = decodeGenerationHandoff(encodePayload({ images: [{ url, width: 1, height: 1 }] }));
    expect(decoded?.params.images).toEqual([{ url, width: 1, height: 1 }]);
  });

  it('keeps first-party entries and strips only the foreign ones (per-entry filter)', () => {
    const good = 'https://orchestration-new.civitai.com/v1/consumer/blobs/x';
    const bad = 'https://evil.example/b.png';
    const decoded = decodeGenerationHandoff(
      encodePayload({
        images: [
          { url: good, width: 1, height: 1 },
          { url: bad, width: 2, height: 2 },
        ],
      })
    );
    expect(decoded?.params.images).toEqual([{ url: good, width: 1, height: 1 }]);
  });

  it('still returns null for a malformed payload', () => {
    expect(decodeGenerationHandoff('!!!not-base64!!!')).toBeNull();
  });
});
