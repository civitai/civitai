import { describe, expect, test } from 'vitest';
import { BLOCK_SCOPE_TO_OAUTH_BIT } from '~/shared/constants/block-scope.constants';
import {
  SCOPE_DESCRIPTIONS,
  SCOPE_PLAIN_TITLES,
} from '~/server/services/blocks/scope-descriptions.constants';

describe('SCOPE_PLAIN_TITLES', () => {
  test('every shipped scope has a plain-language title, so none shows as a developer id', () => {
    const shipped = Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT);
    expect(shipped.length).toBeGreaterThan(5);
    expect(shipped.filter((scope) => !SCOPE_PLAIN_TITLES[scope])).toEqual([]);
  });

  test('a title never repeats the raw scope id', () => {
    for (const [scope, title] of Object.entries(SCOPE_PLAIN_TITLES)) {
      expect(title, scope).not.toContain(':');
      expect(SCOPE_DESCRIPTIONS[scope], `${scope} has a title but no description`).toBeTruthy();
    }
  });
});
