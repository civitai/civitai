import { describe, it, expect } from 'vitest';
import blockedUsernames from '~/utils/blocklist-username.json';

/**
 * Mirror of isUsernamePermitted from user.service.ts.
 * We test against the same JSON blocklist without importing user.service.ts
 * (which pulls in Prisma, Redis, Meilisearch, etc.).
 */
function isUsernamePermitted(username: string): boolean {
  const lower = username.toLowerCase();
  return !(
    blockedUsernames.partial.some((x) => lower.includes(x)) ||
    blockedUsernames.exact.some((x) => lower === x)
  );
}

describe('isUsernamePermitted', () => {
  describe('exact blocklist', () => {
    it('rejects exact matches (case-insensitive)', () => {
      expect(isUsernamePermitted('civitai')).toBe(false);
      expect(isUsernamePermitted('Civitai')).toBe(false);
      expect(isUsernamePermitted('CIVITAI')).toBe(false);
      expect(isUsernamePermitted('admin')).toBe(false);
      expect(isUsernamePermitted('support')).toBe(false);
    });

    it('allows usernames that only partially match an exact-blocked term', () => {
      expect(isUsernamePermitted('admin123')).toBe(true);
      expect(isUsernamePermitted('myadmin')).toBe(true);
    });
  });

  describe('partial blocklist — civit variants', () => {
    it('rejects usernames containing "civit"', () => {
      expect(isUsernamePermitted('civitmod')).toBe(false);
      expect(isUsernamePermitted('civitai_support')).toBe(false);
      expect(isUsernamePermitted('the_civit_team')).toBe(false);
      expect(isUsernamePermitted('Civit')).toBe(false);
      expect(isUsernamePermitted('CIVITADMIN')).toBe(false);
    });

    it('rejects leet-speak civit variants', () => {
      expect(isUsernamePermitted('c1vitai')).toBe(false);
      expect(isUsernamePermitted('civ1tai')).toBe(false);
      expect(isUsernamePermitted('c1v1tai')).toBe(false);
      expect(isUsernamePermitted('C1VIT_staff')).toBe(false);
      expect(isUsernamePermitted('xCIV1Tx')).toBe(false);
    });
  });

  describe('allowed usernames', () => {
    it('allows normal usernames', () => {
      expect(isUsernamePermitted('alice')).toBe(true);
      expect(isUsernamePermitted('bob_123')).toBe(true);
      expect(isUsernamePermitted('ModelMaker99')).toBe(true);
      expect(isUsernamePermitted('PixelArtist')).toBe(true);
    });

    it('allows short substrings that do not match partial blocklist', () => {
      expect(isUsernamePermitted('civic')).toBe(true);
      expect(isUsernamePermitted('civil')).toBe(true);
    });
  });
});
