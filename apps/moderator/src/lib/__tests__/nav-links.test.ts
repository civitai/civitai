import { describe, expect, it } from 'vitest';
import { isNavLinkActive } from '$lib/nav-links';
import {
  applyGrants,
  canAccess,
  NAVIGATION,
  navForUser,
  pageAccessState,
  PERMISSIONS,
  resolvePermissions,
} from '$lib/server/access';

const at = (href: string) => new URL(href, 'https://mod.test');

describe('isNavLinkActive', () => {
  it('marks only the deepest sibling when one path nests under another', () => {
    const users = { path: '/users', label: 'Users' };
    const newest = { path: '/users/newest', label: 'Newest Users' };
    const url = at('/users/newest');
    expect(isNavLinkActive(newest, [users, newest], url)).toBe(true);
    expect(isNavLinkActive(users, [users, newest], url)).toBe(false);
    expect(isNavLinkActive(users, [users, newest], at('/users'))).toBe(true);
  });
});

const reviewer = { roles: ['moderator:reviewer'] };
const labelsUnder = (group: string) =>
  navForUser(reviewer)
    .find((l) => l.label === group)
    ?.children?.map((c) => [c.path, c.label]);

describe('the Users section', () => {
  it('lists Users, Newest Users and Scam Restrictions for someone holding all three', () => {
    applyGrants({
      '/users': ['moderator:reviewer'],
      '/users/newest': ['moderator:reviewer'],
      '/users/scam-restrictions': ['moderator:reviewer'],
    });
    expect(labelsUnder('Users')).toEqual([
      ['/users', 'Users'],
      ['/users/newest', 'Newest Users'],
      ['/users/scam-restrictions', 'Scam Restrictions'],
    ]);
  });

  it('keeps the three grants independent', () => {
    applyGrants({ '/users': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/users')).toBe(true);
    expect(canAccess(reviewer, '/users/scam-restrictions')).toBe(false);
    expect(canAccess(reviewer, '/users/newest')).toBe(false);
    expect(labelsUnder('Users')).toEqual([['/users', 'Users']]);

    applyGrants({ '/users/scam-restrictions': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/users/scam-restrictions')).toBe(true);
    expect(canAccess(reviewer, '/users')).toBe(false);
    expect(labelsUnder('Users')).toEqual([['/users/scam-restrictions', 'Scam Restrictions']]);
  });

  it('leaves Scam Restrictions out of Audit', () => {
    applyGrants({ '/audit/generator-restrictions': ['moderator:reviewer'] });
    expect(labelsUnder('Audit')).toEqual([
      ['/audit/generator-restrictions', 'Generator Restrictions'],
    ]);
    expect(canAccess(reviewer, '/users/scam-restrictions')).toBe(false);
  });
});

describe('the Models section', () => {
  it('shows both pages, each under its own grant', () => {
    applyGrants({
      '/models/minor-hash-matches': ['moderator:reviewer'],
      '/models/flag-appeals': ['moderator:reviewer'],
    });
    expect(labelsUnder('Models')).toEqual([
      ['/models/minor-hash-matches', 'Minor Hash Matches'],
      ['/models/flag-appeals', 'Model Flag Appeals'],
    ]);

    applyGrants({ '/models/minor-hash-matches': ['moderator:reviewer'] });
    expect(labelsUnder('Models')).toEqual([['/models/minor-hash-matches', 'Minor Hash Matches']]);
    expect(canAccess(reviewer, '/models/flag-appeals')).toBe(false);

    applyGrants({ '/models/flag-appeals': ['moderator:reviewer'] });
    expect(labelsUnder('Models')).toEqual([['/models/flag-appeals', 'Model Flag Appeals']]);
    expect(canAccess(reviewer, '/models/minor-hash-matches')).toBe(false);
  });

  it('is hidden from whoever holds neither page', () => {
    applyGrants({ '/bounties/poi-appeals': ['moderator:reviewer'] });
    expect(labelsUnder('Models')).toBeUndefined();
  });
});

describe('/admin grantable pages', () => {
  const tree = pageAccessState().tree;
  const keys = (node: { children: { key: string }[] } | undefined) =>
    node?.children.map((c) => c.key);

  it('lists every Users page as its own grantable row', () => {
    const keysAtTop = tree.map((n) => n.key);
    expect(keysAtTop).toEqual(
      expect.arrayContaining(['/users', '/users/newest', '/users/scam-restrictions'])
    );
    expect(pageAccessState().paths).toEqual(
      expect.arrayContaining(['/users', '/users/newest', '/users/scam-restrictions'])
    );
  });

  it('lists both Models pages as grantable', () => {
    expect(keys(tree.find((n) => n.key === '/models'))).toEqual([
      '/models/minor-hash-matches',
      '/models/flag-appeals',
    ]);
  });
});

describe('the text-scan lab', () => {
  it('declares the text-scan lab permissions and pages', () => {
    const ids = PERMISSIONS.map((p) => p.id);
    expect(ids.filter((id) => id.startsWith('textScan.'))).toEqual([
      'textScan.prompt.publish',
      'textScan.modelRules.edit',
    ]);
    const group = NAVIGATION.find((n) => n.path === '/text-scan');
    expect(group?.children?.map((c) => [c.path, c.label])).toEqual([
      ['/text-scan/prompts', 'Prompts'],
      ['/text-scan/model-rules', 'Model rules'],
    ]);
  });

  it('opens Prompts, and the Check redirect, to a role that held only the retired Check grant', () => {
    applyGrants({ '/text-scan/check': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/text-scan/prompts')).toBe(true);
    expect(canAccess(reviewer, '/text-scan/check')).toBe(true);
    expect(canAccess(reviewer, '/text-scan/model-rules')).toBe(false);
    expect(labelsUnder('Text Scan')).toEqual([['/text-scan/prompts', 'Prompts']]);
  });

  it('gives the retired Check grant no permission', () => {
    applyGrants({ '/text-scan/check': ['moderator:reviewer'] });
    expect(resolvePermissions(reviewer)['textScan.prompt.publish']).toBeUndefined();
  });

  it('keeps a direct Prompts grant beside the retired one', () => {
    applyGrants({
      '/text-scan/prompts': ['moderator:a'],
      '/text-scan/check': ['moderator:b'],
    });
    expect(canAccess({ roles: ['moderator:a'] }, '/text-scan/prompts')).toBe(true);
    expect(canAccess({ roles: ['moderator:b'] }, '/text-scan/prompts')).toBe(true);
  });

  it('does not offer the retired Check page on /admin', () => {
    expect(pageAccessState().paths).not.toContain('/text-scan/check');
  });
});
