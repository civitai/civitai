import { describe, expect, it } from 'vitest';
import {
  isShowcaseButtonUrl,
  profileSectionSchema,
  userProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';

describe('isShowcaseButtonUrl', () => {
  it.each(['/models/123', '/user/someone/articles?sort=Newest', 'https://example.com/shop'])(
    'accepts %s',
    (url) => expect(isShowcaseButtonUrl(url)).toBe(true)
  );

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://example.com',
    'https://civitai.com@evil.example',
    'https://user:pass@example.com',
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    'example.com',
    '',
  ])('refuses %j', (url) => expect(isShowcaseButtonUrl(url)).toBe(false));
});

describe('profileSectionSchema key', () => {
  // Every built-in section key: the six in the column default plus shop, onSale and creatorJourney.
  const storedDefault = [
    { key: 'showcase', enabled: true },
    { key: 'popularModels', enabled: true },
    { key: 'popularArticles', enabled: true },
    { key: 'modelsOverview', enabled: true },
    { key: 'imagesOverview', enabled: true },
    { key: 'recentReviews', enabled: true },
    { key: 'shop', enabled: false },
    { key: 'onSale', enabled: false },
    { key: 'creatorJourney', enabled: true },
  ];

  it('still accepts every existing section key', () => {
    expect(
      userProfileUpdateSchema.safeParse({ profileSectionsSettings: storedDefault }).success
    ).toBe(true);
  });

  it('accepts a custom showcase key', () => {
    expect(profileSectionSchema.safeParse({ key: 'custom:abc_12-3', enabled: true }).success).toBe(
      true
    );
  });

  it.each(['custom:', 'custom:has space', 'notASection', `custom:${'x'.repeat(33)}`])(
    'refuses %j',
    (key) => expect(profileSectionSchema.safeParse({ key, enabled: true }).success).toBe(false)
  );
});
