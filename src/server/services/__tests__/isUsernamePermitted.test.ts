import { describe, it, expect, vi, beforeEach } from 'vitest';
import blockedUsernames from '~/utils/blocklist-username.json';

/**
 * Mirror of isUsernamePermitted from user.service.ts (static-only logic).
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

/**
 * Full async version matching user.service.ts logic, with injectable dynamic data.
 */
async function isUsernamePermittedWithDynamic(
  username: string,
  getDynamic: (type: string) => Promise<string[]>
): Promise<boolean> {
  const lower = username.toLowerCase();

  const staticBlocked =
    blockedUsernames.partial.some((x) => lower.includes(x)) ||
    blockedUsernames.exact.some((x) => lower === x);
  if (staticBlocked) return false;

  const [dynamicExact, dynamicPartial] = await Promise.all([
    getDynamic('UsernameExact'),
    getDynamic('UsernamePartial'),
  ]);

  return !(
    dynamicExact.some((x) => lower === x) ||
    dynamicPartial.some((x) => lower.includes(x))
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

describe('isUsernamePermitted — dynamic blocklist integration', () => {
  const mockGetDynamic = vi.fn<(type: string) => Promise<string[]>>();

  beforeEach(() => {
    mockGetDynamic.mockReset();
  });

  it('rejects usernames matching dynamic exact entries', async () => {
    mockGetDynamic.mockImplementation(async (type) => {
      if (type === 'UsernameExact') return ['spammer99', 'troll_account'];
      return [];
    });

    expect(await isUsernamePermittedWithDynamic('spammer99', mockGetDynamic)).toBe(false);
    expect(await isUsernamePermittedWithDynamic('Spammer99', mockGetDynamic)).toBe(false);
    expect(await isUsernamePermittedWithDynamic('troll_account', mockGetDynamic)).toBe(false);
  });

  it('rejects usernames matching dynamic partial entries', async () => {
    mockGetDynamic.mockImplementation(async (type) => {
      if (type === 'UsernamePartial') return ['scammer'];
      return [];
    });

    expect(await isUsernamePermittedWithDynamic('scammer123', mockGetDynamic)).toBe(false);
    expect(await isUsernamePermittedWithDynamic('thescammer', mockGetDynamic)).toBe(false);
    expect(await isUsernamePermittedWithDynamic('SCAMMER_pro', mockGetDynamic)).toBe(false);
  });

  it('allows usernames not in any blocklist', async () => {
    mockGetDynamic.mockResolvedValue([]);

    expect(await isUsernamePermittedWithDynamic('alice', mockGetDynamic)).toBe(true);
    expect(await isUsernamePermittedWithDynamic('bob_123', mockGetDynamic)).toBe(true);
  });

  it('static blocklist takes precedence over empty dynamic lists', async () => {
    mockGetDynamic.mockResolvedValue([]);

    // 'civitai' is in the static exact list
    expect(await isUsernamePermittedWithDynamic('civitai', mockGetDynamic)).toBe(false);
    // 'civit' substring is in the static partial list
    expect(await isUsernamePermittedWithDynamic('civitmod', mockGetDynamic)).toBe(false);
  });

  it('dynamic exact does not partial-match', async () => {
    mockGetDynamic.mockImplementation(async (type) => {
      if (type === 'UsernameExact') return ['baduser'];
      return [];
    });

    expect(await isUsernamePermittedWithDynamic('baduser', mockGetDynamic)).toBe(false);
    expect(await isUsernamePermittedWithDynamic('baduser123', mockGetDynamic)).toBe(true);
    expect(await isUsernamePermittedWithDynamic('mybaduser', mockGetDynamic)).toBe(true);
  });
});
