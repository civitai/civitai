import { describe, expect, it } from 'vitest';
import { isSiteAppealCategory, siteAppealDecisionText } from '../site-appeal';

describe('siteAppealDecisionText', () => {
  it('says what was put back only when it was', () => {
    expect(siteAppealDecisionText({ category: 'Article', approved: true, restored: true })).toBe(
      'We reviewed your appeal and restored your article.'
    );
    expect(siteAppealDecisionText({ category: 'Model', approved: true, restored: true })).toBe(
      'We reviewed your appeal and republished your model.'
    );
    for (const category of ['Article', 'Model'] as const)
      expect(siteAppealDecisionText({ category, approved: true, restored: false })).toBe(
        'We reviewed your appeal and approved it.'
      );
  });

  it('an approved account appeal says the restriction is lifted only when one was', () => {
    expect(siteAppealDecisionText({ category: 'Account', approved: true, restored: true })).toBe(
      'We reviewed your appeal and lifted the restriction on your account.'
    );
    expect(siteAppealDecisionText({ category: 'Account', approved: true, restored: false })).toBe(
      'We reviewed your appeal and approved it.'
    );
  });

  it('a rejection names the decision, not the current state, per category', () => {
    const rejected = (category: 'Account' | 'Article' | 'Model' | 'Other') =>
      siteAppealDecisionText({ category, approved: false, restored: false });
    expect(rejected('Account')).toBe(
      'We reviewed your appeal. The decision on your account stands.'
    );
    expect(rejected('Article')).toBe(
      'We reviewed your appeal. The decision to unpublish your article stands.'
    );
    expect(rejected('Model')).toBe(
      'We reviewed your appeal. The decision to unpublish your model stands.'
    );
    expect(rejected('Other')).toBe('We reviewed your appeal. The original decision stands.');
  });
});

describe('isSiteAppealCategory', () => {
  it('accepts the four categories and nothing else', () => {
    for (const c of ['Account', 'Article', 'Model', 'Other'])
      expect(isSiteAppealCategory(c)).toBe(true);
    for (const c of [undefined, null, '', 'account', 'Image'])
      expect(isSiteAppealCategory(c)).toBe(false);
  });
});
