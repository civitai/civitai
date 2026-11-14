import { describe, expect, it } from 'vitest';
import { getKnightsLink, KNIGHTS_APP_URL } from '~/shared/constants/knights.constants';

describe('getKnightsLink', () => {
  it('links to the app for a user the app admits, on a colour domain the game was offered on', () => {
    expect(getKnightsLink({ knightsApp: true, newOrderGame: true, isBlue: true })).toEqual({
      href: KNIGHTS_APP_URL,
      visible: true,
    });
  });

  it('keeps the old game link for everyone else', () => {
    expect(getKnightsLink({ newOrderGame: true, isBlue: true })).toEqual({
      href: '/games/knights-of-new-order',
      visible: true,
    });
  });

  it('shows no link on the green site, even for an admitted user', () => {
    expect(getKnightsLink({ knightsApp: true, newOrderGame: false, isBlue: false }).visible).toBe(
      false
    );
  });
});
