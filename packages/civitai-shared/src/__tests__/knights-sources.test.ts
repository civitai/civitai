import { describe, expect, it } from 'vitest';
import {
  KNIGHTS_SOURCES_DEFAULT_MAX_OPEN,
  knightsSourcesMaxOpen,
  parseKnightsSourcesConfig,
  readKnightsSourcesConfig,
} from '../new-order';

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

  it.each([
    ['a fraction', 99.7],
    ['past the safe integer range', 2 ** 53],
  ])('leaves out a maxOpen that is %s, so the default applies', (_, maxOpen) => {
    const { config } = readKnightsSourcesConfig(JSON.stringify({ enabled: true, maxOpen }));
    expect(config).toEqual({ enabled: true, sfwRate: 1, nsfwRate: 0.3 });
    expect(knightsSourcesMaxOpen(config)).toBe(KNIGHTS_SOURCES_DEFAULT_MAX_OPEN);
  });

  it('reads maxOpen as a whole number of open items, and leaves it out when missing or unusable', () => {
    expect(readKnightsSourcesConfig('{"enabled":true,"maxOpen":1200}').config.maxOpen).toBe(1200);
    expect(readKnightsSourcesConfig('{"enabled":true,"maxOpen":0}').config.maxOpen).toBe(0);
    for (const maxOpen of ['5000', -1, null, true]) {
      expect(readKnightsSourcesConfig(JSON.stringify({ enabled: true, maxOpen })).config).toEqual({
        enabled: true,
        sfwRate: 1,
        nsfwRate: 0.3,
      });
    }
  });
});

describe('knightsSourcesMaxOpen', () => {
  it('is the stored cap, or the default when none is stored', () => {
    expect(knightsSourcesMaxOpen(parseKnightsSourcesConfig('{"maxOpen":250}'))).toBe(250);
    expect(knightsSourcesMaxOpen(parseKnightsSourcesConfig('{"maxOpen":0}'))).toBe(0);
    expect(knightsSourcesMaxOpen(parseKnightsSourcesConfig('{"enabled":true}'))).toBe(
      KNIGHTS_SOURCES_DEFAULT_MAX_OPEN
    );
  });
});
