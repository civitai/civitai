import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlocklistService from '~/server/services/blocklist.service';

const getBlocklistData = vi.hoisted(() => vi.fn(async (_type: string): Promise<string[]> => []));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  getBlocklistData,
}));

const { isUsernamePermitted } = await import('~/server/services/username-permitted');

beforeEach(() => {
  getBlocklistData.mockReset();
  getBlocklistData.mockResolvedValue([]);
});

describe('isUsernamePermitted', () => {
  describe('exact blocklist', () => {
    it('rejects exact matches (case-insensitive)', async () => {
      expect(await isUsernamePermitted('civitai')).toBe(false);
      expect(await isUsernamePermitted('Civitai')).toBe(false);
      expect(await isUsernamePermitted('CIVITAI')).toBe(false);
      expect(await isUsernamePermitted('admin')).toBe(false);
      expect(await isUsernamePermitted('support')).toBe(false);
    });

    it('allows usernames that only partially match an exact-blocked term', async () => {
      expect(await isUsernamePermitted('admin123')).toBe(true);
      expect(await isUsernamePermitted('myadmin')).toBe(true);
    });
  });

  describe('partial blocklist — civit variants', () => {
    it('rejects usernames containing "civit"', async () => {
      expect(await isUsernamePermitted('civitmod')).toBe(false);
      expect(await isUsernamePermitted('civitai_support')).toBe(false);
      expect(await isUsernamePermitted('the_civit_team')).toBe(false);
      expect(await isUsernamePermitted('Civit')).toBe(false);
      expect(await isUsernamePermitted('CIVITADMIN')).toBe(false);
    });

    it('rejects leet-speak civit variants', async () => {
      expect(await isUsernamePermitted('c1vitai')).toBe(false);
      expect(await isUsernamePermitted('civ1tai')).toBe(false);
      expect(await isUsernamePermitted('c1v1tai')).toBe(false);
      expect(await isUsernamePermitted('C1VIT_staff')).toBe(false);
      expect(await isUsernamePermitted('xCIV1Tx')).toBe(false);
    });
  });

  describe('allowed usernames', () => {
    it('allows normal usernames', async () => {
      expect(await isUsernamePermitted('alice')).toBe(true);
      expect(await isUsernamePermitted('bob_123')).toBe(true);
      expect(await isUsernamePermitted('ModelMaker99')).toBe(true);
      expect(await isUsernamePermitted('PixelArtist')).toBe(true);
    });

    it('allows short substrings that do not match partial blocklist', async () => {
      expect(await isUsernamePermitted('civic')).toBe(true);
      expect(await isUsernamePermitted('civil')).toBe(true);
    });
  });
});

describe('isUsernamePermitted — dynamic blocklist integration', () => {
  it('rejects usernames matching dynamic exact entries', async () => {
    getBlocklistData.mockImplementation(async (type) => {
      if (type === 'UsernameExact') return ['spammer99', 'troll_account'];
      return [];
    });

    expect(await isUsernamePermitted('spammer99')).toBe(false);
    expect(await isUsernamePermitted('Spammer99')).toBe(false);
    expect(await isUsernamePermitted('troll_account')).toBe(false);
  });

  it('rejects usernames matching dynamic partial entries', async () => {
    getBlocklistData.mockImplementation(async (type) => {
      if (type === 'UsernamePartial') return ['scammer'];
      return [];
    });

    expect(await isUsernamePermitted('scammer123')).toBe(false);
    expect(await isUsernamePermitted('thescammer')).toBe(false);
    expect(await isUsernamePermitted('SCAMMER_pro')).toBe(false);
  });

  it('allows usernames not in any blocklist', async () => {
    getBlocklistData.mockResolvedValue([]);

    expect(await isUsernamePermitted('alice')).toBe(true);
    expect(await isUsernamePermitted('bob_123')).toBe(true);
  });

  it('static blocklist takes precedence over empty dynamic lists', async () => {
    getBlocklistData.mockResolvedValue([]);

    // 'civitai' is in the static exact list
    expect(await isUsernamePermitted('civitai')).toBe(false);
    // 'civit' substring is in the static partial list
    expect(await isUsernamePermitted('civitmod')).toBe(false);
  });

  it('dynamic exact does not partial-match', async () => {
    getBlocklistData.mockImplementation(async (type) => {
      if (type === 'UsernameExact') return ['baduser'];
      return [];
    });

    expect(await isUsernamePermitted('baduser')).toBe(false);
    expect(await isUsernamePermitted('baduser123')).toBe(true);
    expect(await isUsernamePermitted('mybaduser')).toBe(true);
  });
});
