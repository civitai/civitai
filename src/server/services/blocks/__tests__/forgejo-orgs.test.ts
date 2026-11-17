import { describe, expect, it } from 'vitest';
import { resolveForgejoOrgs } from '../forgejo-orgs';

const PREVIEW = {
  FORGEJO_APPS_ORG: 'civitai-apps-preview',
  FORGEJO_REVIEW_ORG: 'civitai-apps-preview-review',
  FORGEJO_SRC_ORG: 'civitai-apps-preview-src',
};

describe('resolveForgejoOrgs', () => {
  it('none set: production orgs, usable', () => {
    expect(resolveForgejoOrgs({})).toEqual({
      apps: 'civitai-apps',
      review: 'civitai-apps-review',
      source: 'civitai-apps-src',
      error: null,
    });
  });

  it('blank values count as unset', () => {
    expect(
      resolveForgejoOrgs({ FORGEJO_APPS_ORG: '', FORGEJO_REVIEW_ORG: '  ', FORGEJO_SRC_ORG: '' })
        .error
    ).toBeNull();
  });

  it('all three set: exactly those orgs, usable', () => {
    expect(resolveForgejoOrgs(PREVIEW)).toEqual({
      apps: 'civitai-apps-preview',
      review: 'civitai-apps-preview-review',
      source: 'civitai-apps-preview-src',
      error: null,
    });
  });

  it.each([['FORGEJO_APPS_ORG'], ['FORGEJO_REVIEW_ORG'], ['FORGEJO_SRC_ORG']] as const)(
    'refuses a partial config missing %s',
    (key) => {
      const r = resolveForgejoOrgs({ ...PREVIEW, [key]: undefined });
      expect(r.error).toBe(
        `Forgejo org config refused: set all of FORGEJO_APPS_ORG, FORGEJO_REVIEW_ORG and FORGEJO_SRC_ORG or none (missing ${key})`
      );
    }
  );

  it.each([
    ['FORGEJO_APPS_ORG', 'civitai-apps'],
    ['FORGEJO_REVIEW_ORG', 'civitai-apps-review'],
    ['FORGEJO_SRC_ORG', 'civitai-apps-src'],
    // A production name in the WRONG slot is refused too: the review flow pointed at the build org.
    ['FORGEJO_REVIEW_ORG', 'civitai-apps'],
  ] as const)('refuses %s = production org %s', (key, value) => {
    const r = resolveForgejoOrgs({ ...PREVIEW, [key]: value });
    expect(r.error).toBe(`Forgejo org config refused: ${key} names the production org ${value}`);
  });

  it('refuses a production org name in another case (Forgejo names are case-insensitive)', () => {
    const r = resolveForgejoOrgs({ ...PREVIEW, FORGEJO_REVIEW_ORG: 'Civitai-Apps-Review' });
    expect(r.error).toBe(
      'Forgejo org config refused: FORGEJO_REVIEW_ORG names the production org Civitai-Apps-Review'
    );
  });

  it('refuses two flows sharing an org that differ only in case', () => {
    const r = resolveForgejoOrgs({ ...PREVIEW, FORGEJO_REVIEW_ORG: 'Civitai-Apps-Preview' });
    expect(r.error).toBe(
      'Forgejo org config refused: FORGEJO_APPS_ORG, FORGEJO_REVIEW_ORG and FORGEJO_SRC_ORG must be distinct'
    );
  });

  it('refuses two flows sharing an org (review snapshots would overwrite build repos)', () => {
    const r = resolveForgejoOrgs({ ...PREVIEW, FORGEJO_REVIEW_ORG: PREVIEW.FORGEJO_APPS_ORG });
    expect(r.error).toBe(
      'Forgejo org config refused: FORGEJO_APPS_ORG, FORGEJO_REVIEW_ORG and FORGEJO_SRC_ORG must be distinct'
    );
  });

  it.each([['has/slash'], ['-leading-dash'], ['a'.repeat(41)]])('refuses invalid name %s', (v) => {
    const r = resolveForgejoOrgs({ ...PREVIEW, FORGEJO_SRC_ORG: v });
    expect(r.error).toBe('Forgejo org config refused: FORGEJO_SRC_ORG is not a valid org name');
  });
});
