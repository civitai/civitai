import { describe, expect, it } from 'vitest';
import {
  getOffsiteReviewChecklist,
  getOnsiteReviewChecklist,
  getReviewChecklist,
  unjustifiedSensitiveBlockScopes,
  unjustifiedSensitiveScopeKeys,
  type OffsiteChecklistData,
} from '../offsiteReviewChecklist';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * W13 P3a — kind-aware mod-review checklist view-model.
 *
 * Pins the invariant that the OFF-SITE (external-link) review is CONTENT-ONLY and
 * omits every ON-SITE code/bundle item, and that the off-site auto-checks derive
 * correctly from the request payload (https URL + asset presence).
 */

const complete: OffsiteChecklistData = {
  name: 'My External App',
  externalUrl: 'https://example.com/app',
  hasIcon: true,
  hasCover: true,
  screenshotCount: 2,
  category: 'utility',
  description: 'A useful off-site tool.',
};

const CODE_ITEM_IDS = ['code-diff', 'bundle', 'manifest', 'scopes'];

describe('getReviewChecklist — kind dispatch', () => {
  it("kind='onsite' returns the deep code checklist (includes code/bundle items)", () => {
    const items = getReviewChecklist('onsite');
    const ids = items.map((i) => i.id);
    for (const id of CODE_ITEM_IDS) expect(ids).toContain(id);
    // Matches the standalone onsite builder.
    expect(items).toEqual(getOnsiteReviewChecklist());
  });

  it("kind='offsite' returns the content-only checklist and OMITS every code/bundle item", () => {
    const items = getReviewChecklist('offsite', complete);
    const ids = items.map((i) => i.id);
    for (const id of CODE_ITEM_IDS) expect(ids).not.toContain(id);
    // Includes the content-specific items.
    expect(ids).toContain('name');
    expect(ids).toContain('url-https');
    expect(ids).toContain('icon');
    expect(ids).toContain('cover');
    expect(ids).toContain('screenshots');
    expect(ids).toContain('description');
    expect(ids).toContain('category');
  });

  it("kind='offsite' with no data falls back to all-warn asset/name/url checks (no throw)", () => {
    const items = getReviewChecklist('offsite');
    const byId = Object.fromEntries(items.map((i) => [i.id, i.status]));
    expect(byId.name).toBe('warn');
    expect(byId['url-https']).toBe('warn');
    expect(byId.icon).toBe('warn');
  });
});

describe('getOffsiteReviewChecklist — auto-derived statuses', () => {
  it('all-present + https URL → name/url/icon/cover/screenshots are ok', () => {
    const byId = Object.fromEntries(
      getOffsiteReviewChecklist(complete).map((i) => [i.id, i.status])
    );
    expect(byId.name).toBe('ok');
    expect(byId['url-https']).toBe('ok');
    expect(byId.icon).toBe('ok');
    expect(byId.cover).toBe('ok');
    expect(byId.screenshots).toBe('ok');
  });

  it('description + category are always mod-judgment (todo), even when set', () => {
    const byId = Object.fromEntries(
      getOffsiteReviewChecklist(complete).map((i) => [i.id, i.status])
    );
    expect(byId.description).toBe('todo');
    expect(byId.category).toBe('todo');
  });

  it('missing assets → warn per missing asset', () => {
    const byId = Object.fromEntries(
      getOffsiteReviewChecklist({
        ...complete,
        hasIcon: false,
        hasCover: false,
        screenshotCount: 0,
      }).map((i) => [i.id, i.status])
    );
    expect(byId.icon).toBe('warn');
    expect(byId.cover).toBe('warn');
    expect(byId.screenshots).toBe('warn');
  });

  it('non-https / empty name → warn', () => {
    const byId = Object.fromEntries(
      getOffsiteReviewChecklist({
        ...complete,
        name: '   ',
        externalUrl: 'http://insecure.example.com',
      }).map((i) => [i.id, i.status])
    );
    expect(byId.name).toBe('warn');
    expect(byId['url-https']).toBe('warn');
  });
});

describe('getOffsiteReviewChecklist — kind-aware url item (onsite media revision)', () => {
  it("kind='onsite' (URL-less media revision) OMITS the url-https item entirely", () => {
    const ids = getOffsiteReviewChecklist({
      ...complete,
      kind: 'onsite',
      externalUrl: null,
    }).map((i) => i.id);
    expect(ids).not.toContain('url-https');
    // The rest of the content checklist is unchanged.
    expect(ids).toContain('name');
    expect(ids).toContain('icon');
    expect(ids).toContain('cover');
    expect(ids).toContain('screenshots');
    expect(ids).toContain('description');
    expect(ids).toContain('category');
  });

  it("offsite (kind omitted) with a bad/http URL STILL warns on url-https", () => {
    const item = getOffsiteReviewChecklist({
      ...complete,
      externalUrl: 'http://insecure.example.com',
    }).find((i) => i.id === 'url-https');
    expect(item?.status).toBe('warn');
  });

  it("kind='offsite' with a bad/http URL STILL warns on url-https (explicit)", () => {
    const item = getOffsiteReviewChecklist({
      ...complete,
      kind: 'offsite',
      externalUrl: 'http://insecure.example.com',
    }).find((i) => i.id === 'url-https');
    expect(item?.status).toBe('warn');
  });

  it("kind='offsite' with a valid https URL keeps the item ok (behaviour unchanged)", () => {
    const item = getOffsiteReviewChecklist({
      ...complete,
      kind: 'offsite',
    }).find((i) => i.id === 'url-https');
    expect(item?.status).toBe('ok');
  });
});

describe('getOffsiteReviewChecklist — connect sensitive-scope item (PR3)', () => {
  const connectBase: OffsiteChecklistData = {
    ...complete,
    connectClientId: 'client-1',
    connectRequestedScopes: TokenScope.ModelsWrite | TokenScope.ModelsRead, // one sensitive, one read
  };

  it('non-connect listing (no connectClientId) has NO sensitive-scope item', () => {
    const ids = getOffsiteReviewChecklist(complete).map((i) => i.id);
    expect(ids).not.toContain('connect-sensitive-scopes');
  });

  it('connect listing with an UNjustified sensitive scope → item present and WARN', () => {
    const item = getOffsiteReviewChecklist({
      ...connectBase,
      connectScopeJustifications: {}, // ModelsWrite is sensitive + unjustified
    }).find((i) => i.id === 'connect-sensitive-scopes');
    expect(item?.status).toBe('warn');
    expect(item?.hint).toContain('ModelsWrite');
  });

  it('connect listing with every sensitive scope justified → item OK', () => {
    const item = getOffsiteReviewChecklist({
      ...connectBase,
      connectScopeJustifications: { ModelsWrite: 'We edit models for the user.' },
    }).find((i) => i.id === 'connect-sensitive-scopes');
    expect(item?.status).toBe('ok');
  });

  it('a NON-sensitive unjustified scope does not warn (item is OK)', () => {
    // Only ModelsRead requested (non-sensitive) → nothing to justify.
    const item = getOffsiteReviewChecklist({
      ...connectBase,
      connectRequestedScopes: TokenScope.ModelsRead,
      connectScopeJustifications: {},
    }).find((i) => i.id === 'connect-sensitive-scopes');
    expect(item?.status).toBe('ok');
  });
});

describe('getOnsiteReviewChecklist — auto-derived scopes item (block sensitive scopes)', () => {
  const scopesStatus = (data?: Parameters<typeof getOnsiteReviewChecklist>[0]) =>
    getOnsiteReviewChecklist(data).find((i) => i.id === 'scopes');

  it('with NO data the scopes item stays a mod-judgment todo (backward compatible)', () => {
    expect(scopesStatus()?.status).toBe('todo');
  });

  it('a declared sensitive scope WITHOUT a justification → warn, hint names the scope', () => {
    const item = scopesStatus({ scopes: ['apps:storage:shared:write'] });
    expect(item?.status).toBe('warn');
    expect(item?.hint).toContain('apps:storage:shared:write');
  });

  it('every declared sensitive scope justified → ok, hint surfaces the justification', () => {
    const item = scopesStatus({
      scopes: ['apps:storage:shared:write'],
      scopeJustifications: {
        'apps:storage:shared:write': 'We persist shared gallery entries.',
      },
    });
    expect(item?.status).toBe('ok');
    expect(item?.hint).toContain('apps:storage:shared:write');
    expect(item?.hint).toContain('We persist shared gallery entries.');
  });

  it('data present but NO sensitive scopes declared → ok (nothing to justify)', () => {
    const item = scopesStatus({ scopes: ['models:read:self'] });
    expect(item?.status).toBe('ok');
  });

  it('multiple sensitive scopes, one justified one not → warn, hint names the unjustified one', () => {
    const item = scopesStatus({
      scopes: ['collections:read:private', 'apps:storage:shared:write'],
      scopeJustifications: { 'collections:read:private': 'We read private collections.' },
    });
    expect(item?.status).toBe('warn');
    expect(item?.hint).toContain('apps:storage:shared:write');
  });
});

describe('unjustifiedSensitiveBlockScopes', () => {
  it('returns declared sensitive block scopes lacking a non-empty justification', () => {
    expect(
      unjustifiedSensitiveBlockScopes({
        scopes: ['models:read:self', 'collections:read:private', 'apps:storage:shared:write'],
        scopeJustifications: { 'collections:read:private': 'ok' }, // shared:write missing
      })
    ).toEqual(['apps:storage:shared:write']);
  });

  it('empty when no sensitive scope is declared', () => {
    expect(unjustifiedSensitiveBlockScopes({ scopes: ['models:read:self'] })).toEqual([]);
  });

  it('whitespace-only justification counts as missing', () => {
    expect(
      unjustifiedSensitiveBlockScopes({
        scopes: ['apps:storage:shared:write'],
        scopeJustifications: { 'apps:storage:shared:write': '   ' },
      })
    ).toEqual(['apps:storage:shared:write']);
  });
});

describe('unjustifiedSensitiveScopeKeys', () => {
  it('returns the enum-keys of sensitive requested scopes lacking a non-empty justification', () => {
    expect(
      unjustifiedSensitiveScopeKeys({
        connectRequestedScopes: TokenScope.ModelsWrite | TokenScope.MediaWrite,
        connectScopeJustifications: { ModelsWrite: 'ok' }, // MediaWrite missing
      })
    ).toEqual(['MediaWrite']);
  });

  it('empty when no sensitive scope is requested', () => {
    expect(
      unjustifiedSensitiveScopeKeys({
        connectRequestedScopes: TokenScope.ModelsRead,
        connectScopeJustifications: {},
      })
    ).toEqual([]);
  });

  it('whitespace-only justification counts as missing', () => {
    expect(
      unjustifiedSensitiveScopeKeys({
        connectRequestedScopes: TokenScope.ModelsWrite,
        connectScopeJustifications: { ModelsWrite: '   ' },
      })
    ).toEqual(['ModelsWrite']);
  });
});
