import { describe, expect, it } from 'vitest';
import { containsPrivateMediaUrl } from '../shared-private-media-urls';

describe('containsPrivateMediaUrl', () => {
  it.each([
    [
      'consumer blob',
      'https://orchestration.civitai.com/v2/consumer/blobs/AbC123.jpeg?sig=x&exp=y',
    ],
    ['blob on the region proxy', 'https://orchestration-proxy.civitai.com/v2/consumer/blobs/abc'],
    [
      'job asset',
      'https://orchestration-new.civitai.com/v1/consumer/jobs/0f8fad5b-d9cb-469f-a165-70867728950e/assets/out.png',
    ],
    ['bare host inside prose', 'look: orchestration.civitai.com/whatever'],
    ['blob path without a known host', 'https://cdn.example.net/v2/consumer/blobs/abc123'],
    ['upper case', 'HTTPS://ORCHESTRATION.CIVITAI.COM/V2/CONSUMER/BLOBS/ABC'],
    [
      'double percent-encoded',
      encodeURIComponent(encodeURIComponent('https://orchestration.civitai.com/x')),
    ],
    ['split by an invisible character', 'https://orches​tration.civitai.com/v2/consumer/blobs/abc'],
  ])('matches a %s', (_label, text) => {
    expect(containsPrivateMediaUrl(text)).toBe(true);
  });

  it.each([
    ['public image cdn', 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/abc/width=450/1.jpeg'],
    ['civitai page link', 'https://civitai.com/models/12345'],
    ['the word alone', 'orchestration is hard'],
    ['a look-alike host', 'https://myorchestration.civitai.com.example.org/x'],
    ['plain text', 'a cat on a windowsill'],
    ['malformed percent escape', '100% sure %E0%A4%A'],
  ])('ignores a %s', (_label, text) => {
    expect(containsPrivateMediaUrl(text)).toBe(false);
  });
});
