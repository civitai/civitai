import { describe, expect, it } from 'vitest';
import { parseKnightsSourcesConfig, readKnightsSourcesConfig } from '../new-order';

describe('readKnightsSourcesConfig', () => {
  it.each([null, '', 'not json', '[]', '"on"', 'null'])('is not stored for %j', (raw) => {
    expect(readKnightsSourcesConfig(raw)).toEqual({
      stored: false,
      config: { enabled: false, sfwRate: 1, nsfwRate: 0.3 },
    });
  });

  it('is stored for an object, filling a missing rate with the default', () => {
    expect(readKnightsSourcesConfig('{"enabled":true,"sfwRate":0.05}')).toEqual({
      stored: true,
      config: { enabled: true, sfwRate: 0.05, nsfwRate: 0.3 },
    });
  });

  it('reads a Buffer like a string and agrees with parseKnightsSourcesConfig', () => {
    const raw = '{"enabled":true,"sfwRate":4,"nsfwRate":-1}';
    expect(parseKnightsSourcesConfig(Buffer.from(raw))).toEqual({
      enabled: true,
      sfwRate: 1,
      nsfwRate: 0,
    });
    expect(parseKnightsSourcesConfig(raw)).toEqual(readKnightsSourcesConfig(raw).config);
  });
});
