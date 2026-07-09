import { describe, it, expect } from 'vitest';
import { firstPartyClientId, FIRST_PARTY_ID_PREFIX } from '../first-party';

describe('firstPartyClientId', () => {
  it('derives a stable id from the host, sanitizing non-alphanumerics', () => {
    expect(firstPartyClientId('https://civitai.red')).toBe(`${FIRST_PARTY_ID_PREFIX}civitai_red`);
    expect(firstPartyClientId('https://moderator.civitai.com')).toBe(
      `${FIRST_PARTY_ID_PREFIX}moderator_civitai_com`
    );
  });

  it('ignores DEFAULT ports so prod ids are unchanged (443/80 normalize away)', () => {
    expect(firstPartyClientId('https://civitai.red:443')).toBe(
      `${FIRST_PARTY_ID_PREFIX}civitai_red`
    );
    expect(firstPartyClientId('http://example.com:80')).toBe(`${FIRST_PARTY_ID_PREFIX}example_com`);
  });

  it('INCLUDES a non-default port so two ports of one host get DISTINCT ids', () => {
    const a = firstPartyClientId('http://localhost:3000');
    const b = firstPartyClientId('http://localhost:5173');
    expect(a).toBe(`${FIRST_PARTY_ID_PREFIX}localhost_3000`);
    expect(b).toBe(`${FIRST_PARTY_ID_PREFIX}localhost_5173`);
    expect(a).not.toBe(b); // the dev-collision the port-awareness fixes
  });

  it('is case-insensitive on the host', () => {
    expect(firstPartyClientId('https://CIVITAI.RED')).toBe(`${FIRST_PARTY_ID_PREFIX}civitai_red`);
  });
});
