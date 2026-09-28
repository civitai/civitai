import { describe, expect, it } from 'vitest';
import { isMediaHost } from '~/shared/utils/media-host';

/**
 * Unit pins for the shared media-host gate. The mapper (server) and the
 * `?gen=` handoff decode (client) both consume this helper, so the host
 * policy lives in exactly one place.
 */

const IMAGE_LOCATION = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA';

describe('isMediaHost', () => {
  it('accepts orchestration* first-party hosts', () => {
    expect(
      isMediaHost('https://orchestration.civitai.com/v1/consumer/blobs/x', IMAGE_LOCATION)
    ).toBe(true);
    expect(isMediaHost('https://orchestration-new.civitai.com/x', IMAGE_LOCATION)).toBe(true);
    expect(isMediaHost('https://orchestration-next.civitai.com/x', IMAGE_LOCATION)).toBe(true);
  });

  it('accepts the configured image CDN host', () => {
    expect(isMediaHost(`${IMAGE_LOCATION}/00000-1/x.png`, IMAGE_LOCATION)).toBe(true);
  });

  it('rejects app-origin and foreign URLs', () => {
    expect(isMediaHost('https://civitai.com/private-endpoint.png', IMAGE_LOCATION)).toBe(false);
    expect(isMediaHost('https://evil.example/a.png', IMAGE_LOCATION)).toBe(false);
    expect(isMediaHost('https://notorchestration.civitai.com/x', IMAGE_LOCATION)).toBe(false);
    expect(isMediaHost('https://orchestration.civitai.com.evil.example/x', IMAGE_LOCATION)).toBe(
      false
    );
  });

  it('rejects non-https URLs', () => {
    expect(isMediaHost('http://orchestration.civitai.com/x', IMAGE_LOCATION)).toBe(false);
  });

  it('rejects unparseable and non-string values', () => {
    expect(isMediaHost('not a url', IMAGE_LOCATION)).toBe(false);
    expect(isMediaHost(undefined, IMAGE_LOCATION)).toBe(false);
    expect(isMediaHost(123, IMAGE_LOCATION)).toBe(false);
  });

  it('allows localhost only when the configured image location is itself localhost (dev)', () => {
    expect(isMediaHost('http://localhost:3000/img.png', 'http://localhost:3000')).toBe(true);
    expect(isMediaHost('https://localhost/img.png', IMAGE_LOCATION)).toBe(false);
  });

  it('fails closed when no image location is configured', () => {
    expect(isMediaHost('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/x.png', undefined)).toBe(
      false
    );
    expect(isMediaHost('https://orchestration.civitai.com/x', '')).toBe(true);
  });
});
