import { describe, expect, it } from 'vitest';
import { isNavLinkActive } from '$lib/nav-links';
import {
  applyGrants,
  canAccess,
  NAVIGATION,
  navForUser,
  pageAccessState,
  PERMISSIONS,
  permissionKey,
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

  it('gives Strike Review its own grant and badge, conferring nothing on /users', () => {
    applyGrants({ '/users/strike-review': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/users/strike-review')).toBe(true);
    expect(canAccess(reviewer, '/users')).toBe(false);
    expect(
      navForUser(reviewer)
        .find((l) => l.label === 'Users')
        ?.children?.map((c) => [c.path, c.label, c.countKey])
    ).toEqual([['/users/strike-review', 'Strike Review', 'strikeReview']]);

    applyGrants({ '/users': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/users/strike-review')).toBe(false);
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
  it('shows every page, each under its own grant', () => {
    applyGrants({
      '/models/minor-hash-matches': ['moderator:reviewer'],
      '/models/flag-appeals': ['moderator:reviewer'],
      '/models/held-detections': ['moderator:reviewer'],
    });
    expect(labelsUnder('Models')).toEqual([
      ['/models/minor-hash-matches', 'Minor Hash Matches'],
      ['/models/flag-appeals', 'Model Flag Appeals'],
      ['/models/held-detections', 'Held Detections'],
    ]);

    applyGrants({ '/models/minor-hash-matches': ['moderator:reviewer'] });
    expect(labelsUnder('Models')).toEqual([['/models/minor-hash-matches', 'Minor Hash Matches']]);
    expect(canAccess(reviewer, '/models/flag-appeals')).toBe(false);

    applyGrants({ '/models/flag-appeals': ['moderator:reviewer'] });
    expect(labelsUnder('Models')).toEqual([['/models/flag-appeals', 'Model Flag Appeals']]);
    expect(canAccess(reviewer, '/models/minor-hash-matches')).toBe(false);
    expect(canAccess(reviewer, '/models/held-detections')).toBe(false);

    applyGrants({ '/models/held-detections': ['moderator:reviewer'] });
    expect(labelsUnder('Models')).toEqual([['/models/held-detections', 'Held Detections']]);
    expect(canAccess(reviewer, '/models/flag-appeals')).toBe(false);
  });

  it('badges every queue', () => {
    const models = NAVIGATION.find((n) => n.path === '/models');
    expect(models?.children?.map((c) => [c.path, c.countKey])).toEqual([
      ['/models/minor-hash-matches', 'minorHashMatches'],
      ['/models/flag-appeals', 'modelFlagAppeals'],
      ['/models/held-detections', 'heldDetections'],
    ]);
  });

  it('is hidden from whoever holds neither page', () => {
    applyGrants({ '/bounties/poi-appeals': ['moderator:reviewer'] });
    expect(labelsUnder('Models')).toBeUndefined();
  });
});

describe('CSAM text holds', () => {
  it('sits under Text Scan with its own grant and badge, apart from the image CSAM queue', () => {
    applyGrants({ '/csam/text-holds': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/csam/text-holds')).toBe(true);
    expect(canAccess(reviewer, '/images/csam')).toBe(false);
    expect(
      navForUser(reviewer)
        .find((l) => l.label === 'Text Scan')
        ?.children?.map((c) => [c.path, c.label, c.countKey])
    ).toEqual([['/csam/text-holds', 'CSAM holds', 'csamTextHolds']]);

    applyGrants({ '/images/csam': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/csam/text-holds')).toBe(false);
  });

  it('is grantable on /admin', () => {
    const textScan = pageAccessState().tree.find((n) => n.key === '/text-scan');
    expect(textScan?.children.map((c) => c.key)).toContain('/csam/text-holds');
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

  it('lists every Models page as grantable', () => {
    expect(keys(tree.find((n) => n.key === '/models'))).toEqual([
      '/models/minor-hash-matches',
      '/models/flag-appeals',
      '/models/held-detections',
    ]);
  });
});

describe('/admin action grants', () => {
  const { actions, granted } = pageAccessState();

  // Flat and sorted on the grant key `/admin` shows in its own column, so one key's actions sit together.
  it('lists every permission once, flat, in grant-key order', () => {
    const ids = PERMISSIONS.map((p) => p.id).sort((a, b) => a.localeCompare(b));
    expect(actions.map((a) => a.key)).toEqual(ids.map(permissionKey));
    expect(actions.every((a) => a.kind === 'permission' && !a.children.length)).toBe(true);
    for (const a of actions) expect(granted).toHaveProperty(a.key);
  });
});

describe('the text-scan lab', () => {
  it('declares the text-scan lab permissions and pages', () => {
    const ids = PERMISSIONS.map((p) => p.id);
    expect(ids.filter((id) => id.startsWith('textScan.'))).toEqual([
      'textScan.prompt.publish',
      'textScan.modelRules.edit',
      'textScan.testSets.edit',
    ]);
    const group = NAVIGATION.find((n) => n.path === '/text-scan');
    expect(group?.children?.map((c) => [c.path, c.label])).toEqual([
      ['/csam/text-holds', 'CSAM holds'],
      ['/text-scan/prompts', 'Prompts'],
      ['/text-scan/model-rules', 'Model rules'],
    ]);
  });

  it('does not offer the retired Check page on /admin', () => {
    expect(pageAccessState().paths).not.toContain('/text-scan/check');
  });
});

describe('the Model rules history endpoint', () => {
  it('is gated with the Model rules page', () => {
    applyGrants({ '/text-scan/model-rules': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/text-scan/model-rules/history')).toBe(true);

    applyGrants({ '/text-scan/prompts': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/text-scan/model-rules/history')).toBe(false);
  });
});

describe('the Feedback section', () => {
  const feedback = () => NAVIGATION.find((n) => n.path === '/feedback');
  const platformHref = '/feedback?area=apps-platform&status=new';

  it('keeps one grant, on /feedback, for the queue and its developer-platform view', () => {
    expect(feedback()?.sharedAccess).toBe(true);
    expect(feedback()?.children?.map((c) => [c.path, c.countKey])).toEqual([
      ['/feedback', 'feedbackNew'],
      [platformHref, 'feedbackAppsPlatformNew'],
    ]);
    const { tree, granted } = pageAccessState();
    expect(tree.filter((n) => n.key.startsWith('/feedback')).map((n) => [n.key, n.kind])).toEqual([
      ['/feedback', 'page'],
    ]);
    expect(Object.keys(granted).filter((k) => k.startsWith('/feedback'))).toEqual(['/feedback']);
  });

  it('shows both links, counts and all, to whoever holds /feedback, and neither to anyone else', () => {
    applyGrants({ '/feedback': ['moderator:reviewer'] });
    expect(labelsUnder('Feedback')).toEqual([
      ['/feedback', 'General queue'],
      [platformHref, 'Apps platform (developers)'],
    ]);
    expect(canAccess(reviewer, '/feedback')).toBe(true);
    expect(canAccess(reviewer, '/feedback/12')).toBe(true);

    applyGrants({ '/abuse': ['moderator:reviewer'] });
    expect(labelsUnder('Feedback')).toBeUndefined();
    expect(canAccess(reviewer, '/feedback')).toBe(false);
  });

  it('marks the developer-platform link active on its view and the queue link everywhere else', () => {
    const links = feedback()?.children ?? [];
    const [general, platform] = links;
    const active = (href: string) =>
      [general, platform].map((l) => isNavLinkActive(l, links, at(href)));
    expect(active('/feedback?area=apps-platform&status=new')).toEqual([false, true]);
    expect(active('/feedback?status=new&area=apps-platform&sort=age')).toEqual([false, true]);
    expect(active('/feedback?status=new')).toEqual([true, false]);
    expect(active('/feedback?area=apps-platform&status=reviewed')).toEqual([true, false]);
    expect(active('/feedback/12')).toEqual([true, false]);
    expect(active('/abuse')).toEqual([false, false]);
  });
});
