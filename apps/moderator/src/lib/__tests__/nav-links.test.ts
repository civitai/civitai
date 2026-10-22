import { describe, expect, it } from 'vitest';
import { isNavLinkActive, navCount, navHref, switcherEntries } from '$lib/nav-links';
import {
  applyGrants,
  canAccess,
  isGrantable,
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
  const APPEALS = '/models/flags/appeals';
  const AUTO = '/models/flags/auto';
  const NEEDS_REVIEW = '/models/flags/needs-review';
  const DETECTIONS = permissionKey('modelFlags.detections.decide');
  const MATCHES = permissionKey('modelFlags.fileMatches.decide');
  const flags = (roles = reviewer) =>
    navForUser(roles)
      .find((l) => l.label === 'Models')
      ?.children?.find((c) => c.path === '/models/flags');
  const counts: Record<string, number> = {
    modelFlagsAppeals: 3,
    modelFlagsAuto: 5,
    modelFlagsNeedsReview: 7,
    modelFlagsNeedsReviewDetections: 2,
    modelFlagsNeedsReviewMatches: 6,
  };
  const countFor = (key: string | undefined) => (key ? counts[key] ?? null : null);
  const needsReview = () => flags()?.children?.find((c) => c.path === NEEDS_REVIEW);

  it('is one Model Flags entry holding the three tabs, each under its own grant', () => {
    applyGrants({
      [APPEALS]: ['moderator:reviewer'],
      [AUTO]: ['moderator:reviewer'],
      [NEEDS_REVIEW]: ['moderator:reviewer'],
    });
    expect(labelsUnder('Models')).toEqual([['/models/flags', 'Model Flags']]);
    expect(flags()?.tabs).toBe(true);
    expect(flags()?.children?.map((c) => [c.path, c.label])).toEqual([
      [APPEALS, 'Appeals'],
      [AUTO, 'Auto-flagged'],
      [NEEDS_REVIEW, 'Needs review'],
    ]);
  });

  it('points the one entry at the first tab held and sums only the held tabs', () => {
    applyGrants({
      [AUTO]: ['moderator:reviewer'],
      [NEEDS_REVIEW]: ['moderator:reviewer'],
      [DETECTIONS]: ['moderator:reviewer'],
      [MATCHES]: ['moderator:reviewer'],
    });
    const entry = flags()!;
    expect(navHref(entry)).toBe(AUTO);
    expect(navCount(entry, countFor)).toBe(12);
    const models = navForUser(reviewer).find((l) => l.label === 'Models')!;
    expect(navCount(models, countFor)).toBe(12);
  });

  it('badges Needs review with only the kinds of lead the viewer may rule', () => {
    applyGrants({ [NEEDS_REVIEW]: ['moderator:reviewer'], [MATCHES]: ['moderator:reviewer'] });
    expect(needsReview()?.countKey).toBe('modelFlagsNeedsReviewMatches');
    applyGrants({ [NEEDS_REVIEW]: ['moderator:reviewer'], [DETECTIONS]: ['moderator:reviewer'] });
    expect(needsReview()?.countKey).toBe('modelFlagsNeedsReviewDetections');
    applyGrants({ [NEEDS_REVIEW]: ['moderator:reviewer'] });
    expect(needsReview()?.countKey).toBeUndefined();
    // The admin holds every permission, so every lead.
    expect(
      navForUser({ roles: ['moderator:admin'] })
        .find((l) => l.label === 'Models')
        ?.children?.[0]?.children?.find((c) => c.path === NEEDS_REVIEW)?.countKey
    ).toBe('modelFlagsNeedsReview');
  });

  it('lets a user holding only Appeals open Appeals and nothing else', () => {
    applyGrants({ [APPEALS]: ['moderator:reviewer'] });
    expect(flags()?.children?.map((c) => c.path)).toEqual([APPEALS]);
    expect(navHref(flags()!)).toBe(APPEALS);
    expect(navCount(flags()!, countFor)).toBe(3);
    expect(canAccess(reviewer, APPEALS)).toBe(true);
    expect(canAccess(reviewer, AUTO)).toBe(false);
    expect(canAccess(reviewer, NEEDS_REVIEW)).toBe(false);
  });

  it('is active on every tab of the entry', () => {
    applyGrants({ [AUTO]: ['moderator:reviewer'] });
    const entry = flags()!;
    expect(isNavLinkActive(entry, [entry], at('/models/flags/auto?source=hash'))).toBe(true);
    expect(isNavLinkActive(entry, [entry], at('/models/flags/needs-review'))).toBe(true);
    expect(isNavLinkActive(entry, [entry], at('/models'))).toBe(false);
  });

  it('badges every tab', () => {
    const group = NAVIGATION.find((n) => n.path === '/models')?.children?.[0];
    expect(group?.children?.map((c) => [c.path, c.countKey])).toEqual([
      [APPEALS, 'modelFlagsAppeals'],
      [AUTO, 'modelFlagsAuto'],
      [NEEDS_REVIEW, 'modelFlagsNeedsReview'],
    ]);
  });

  it('is hidden from whoever holds none of the tabs', () => {
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
      '/models/flags/appeals',
      '/models/flags/auto',
      '/models/flags/needs-review',
      '/models/rule-matches',
    ]);
    expect(isGrantable('/models/flags')).toBe(false);
    expect(isGrantable('/models/flags/needs-review')).toBe(true);
    expect(isGrantable('/models/flags/review')).toBe(false);
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

describe('switcherEntries', () => {
  const civitai = 'https://civitai.test';

  it('lists a top-level page by its label and a group child as "Group › Page"', () => {
    const entries = switcherEntries(
      [
        { path: '/', label: 'Dashboard' },
        {
          label: 'Images',
          children: [{ path: '/images/review', label: 'Review' }],
        },
      ],
      civitai
    );
    expect(entries).toEqual([
      { label: 'Dashboard', href: '/', external: false },
      { label: 'Images › Review', href: '/images/review', external: false },
    ]);
  });

  it('lists a tabs group once, at the href the sidebar opens', () => {
    const entries = switcherEntries(
      [
        {
          label: 'Decisions',
          children: [
            {
              label: 'Support',
              tabs: true,
              path: '/decisions/support',
              children: [
                { path: '/decisions/support/open', label: 'Open' },
                { path: '/decisions/support/closed', label: 'Closed' },
              ],
            },
          ],
        },
      ],
      civitai
    );
    expect(entries).toEqual([
      { label: 'Decisions › Support', href: '/decisions/support/open', external: false },
    ]);
  });

  it('points an external link at the main site', () => {
    const entries = switcherEntries(
      [{ label: 'Site', children: [{ path: '/moderator/x', label: 'Old page', external: true }] }],
      civitai
    );
    expect(entries).toEqual([
      { label: 'Site › Old page', href: 'https://civitai.test/moderator/x', external: true },
    ]);
  });

  it('skips a group with no reachable page', () => {
    expect(switcherEntries([{ label: 'Empty', children: [] }], civitai)).toEqual([]);
  });
});

describe('Model rule matches', () => {
  it('sits under Models with its own grant, apart from the model flag queues', () => {
    applyGrants({ '/models/rule-matches': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/models/rule-matches')).toBe(true);
    expect(canAccess(reviewer, '/models/flags/needs-review')).toBe(false);
    expect(
      navForUser(reviewer)
        .find((l) => l.label === 'Models')
        ?.children?.map((c) => [c.path, c.label])
    ).toEqual([['/models/rule-matches', 'Model rule matches']]);

    applyGrants({ '/models/flags/needs-review': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/models/rule-matches')).toBe(false);
  });
});
