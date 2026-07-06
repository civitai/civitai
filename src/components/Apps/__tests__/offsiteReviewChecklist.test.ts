import { describe, expect, it } from 'vitest';
import {
  getOffsiteReviewChecklist,
  getOnsiteReviewChecklist,
  getReviewChecklist,
  type OffsiteChecklistData,
} from '../offsiteReviewChecklist';

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
