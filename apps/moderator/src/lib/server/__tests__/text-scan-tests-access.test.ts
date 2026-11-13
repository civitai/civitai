import { beforeEach, describe, expect, it } from 'vitest';
import { applyGrants, canAccess } from '../access';

const user = (roles: string[]) => ({ roles });

beforeEach(() => {
  applyGrants({
    '/text-scan/prompts': ['moderator:prompts'],
    '/text-scan/model-rules': ['moderator:rules'],
  });
});

describe('test-set routes', () => {
  it('open with either workspace page grant', () => {
    expect(canAccess(user(['moderator:prompts']), '/text-scan/test-sets/4')).toBe(true);
    expect(canAccess(user(['moderator:rules']), '/text-scan/test-sets/4/runs/9')).toBe(true);
  });

  it('stay closed without a text-scan grant', () => {
    expect(canAccess(user(['moderator:other']), '/text-scan/test-sets/4')).toBe(false);
  });
});
