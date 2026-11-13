import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `/admin`'s column order (`COLUMN_ORDER`, `byTrust`): each team's ladder ascending, then every other
 * role alphabetically. The list sorts and never filters, and it says when it names a role the hub has
 * dropped — the silent version of that is how it went stale.
 */

const listAppRoles = vi.fn(async () => [] as string[]);
vi.mock('@civitai/db-queries/page-access', () => ({ listAppRoles }));
vi.mock('../db', () => ({ dbRead: {} }));

const { grantableRoles } = await import('../roles');

// The hub's moderator roles as of 2026-10-16, in its own (id) order.
const HUB = [
  'moderator:admin',
  'moderator:cm-high-access',
  'moderator:membership-codes',
  'moderator:mod-high-access',
  'moderator:mod-medium-access',
  'moderator:payroll',
  'moderator:scan-labels',
];

afterEach(() => vi.restoreAllMocks());

describe('grantableRoles column order', () => {
  it('puts the ladders first, ascending, then the rest alphabetically', async () => {
    listAppRoles.mockResolvedValueOnce(HUB);
    expect(await grantableRoles()).toEqual([
      'moderator:mod-medium-access',
      'moderator:mod-high-access',
      'moderator:cm-high-access',
      'moderator:membership-codes',
      'moderator:payroll',
      'moderator:scan-labels',
    ]);
  });

  it('still shows a role it has never heard of, after the ordered ones', async () => {
    listAppRoles.mockResolvedValueOnce([...HUB, 'moderator:aaa-new']);
    const roles = await grantableRoles();
    expect(roles?.indexOf('moderator:aaa-new')).toBe(3);
  });

  it('warns when the order names a role the hub no longer has', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listAppRoles.mockResolvedValueOnce(HUB.filter((r) => r !== 'moderator:mod-high-access'));
    await grantableRoles();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('moderator:mod-high-access'));
  });

  it('does not warn when every ordered role exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listAppRoles.mockResolvedValueOnce(HUB);
    await grantableRoles();
    expect(warn).not.toHaveBeenCalled();
  });
});
