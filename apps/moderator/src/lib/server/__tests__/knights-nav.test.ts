import { describe, expect, it } from 'vitest';
import { applyGrants, canAccess, NAVIGATION, navForUser, pageAccessState } from '../access';

const reviewer = { roles: ['moderator:reviewer'] };
const KNIGHTS = '/knights-of-new-order';

const knightsGroup = () => navForUser(reviewer).find((l) => l.label === 'Knights of New Order');

describe('the Knights of New Order section', () => {
  it('holds the three pages under one group that has no grant of its own', () => {
    const group = NAVIGATION.find((l) => l.label === 'Knights of New Order');
    expect(group?.path).toBeUndefined();
    expect(group?.children?.map((c) => [c.path, c.label])).toEqual([
      [`${KNIGHTS}/inquisitor`, 'Inquisitor'],
      [`${KNIGHTS}/trials`, 'Trials'],
      [KNIGHTS, 'Linked accounts'],
    ]);
  });

  it('keeps a grant on each page independent of the others', () => {
    applyGrants({ [`${KNIGHTS}/trials`]: ['moderator:reviewer'] });
    expect(canAccess(reviewer, `${KNIGHTS}/trials`)).toBe(true);
    expect(canAccess(reviewer, `${KNIGHTS}/inquisitor`)).toBe(false);
    expect(canAccess(reviewer, KNIGHTS)).toBe(false);
    expect(knightsGroup()?.children?.map((c) => c.path)).toEqual([`${KNIGHTS}/trials`]);

    applyGrants({ [KNIGHTS]: ['moderator:reviewer'] });
    expect(canAccess(reviewer, KNIGHTS)).toBe(true);
    expect(canAccess(reviewer, `${KNIGHTS}/inquisitor`)).toBe(false);
  });

  it('is hidden from whoever holds none of the pages', () => {
    applyGrants({});
    expect(knightsGroup()).toBeUndefined();
  });

  it('lists every page as grantable on /admin', () => {
    const keys = JSON.stringify(pageAccessState().tree);
    for (const path of [KNIGHTS, `${KNIGHTS}/inquisitor`, `${KNIGHTS}/trials`]) {
      expect(keys).toContain(`"key":"${path}"`);
    }
  });
});
