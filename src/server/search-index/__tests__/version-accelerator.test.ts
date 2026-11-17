import { describe, expect, it } from 'vitest';
import { getVersionAccelerator } from '~/server/search-index/version-accelerator';

const band = { steps: { min: 4, max: 8, default: 6 }, cfgScale: { min: 1, max: 2, default: 1 } };

describe('getVersionAccelerator', () => {
  it.each([
    ['a turbo block alone', { turbo: band }, 'turbo'],
    [
      'the accelerator key beside its block',
      { accelerator: 'turbo', sampling: band, turbo: band },
      'turbo',
    ],
    ['an accelerator with no block', { accelerator: 'lightning' }, 'lightning'],
    ['an accelerator switched off beside a stale block', { accelerator: null, turbo: band }, null],
    ['turbo: null', { turbo: null }, null],
    ['no settings', null, null],
  ])('%s', (_, settings, expected) => {
    expect(getVersionAccelerator(settings)).toBe(expected);
  });
});
