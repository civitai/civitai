import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadPageAccessGrants, guardCheck, logToAxiom, logAxiomError, releaseLeasesAtBoot } =
  vi.hoisted(() => ({
    loadPageAccessGrants: vi.fn(async () => ({})),
    guardCheck: vi.fn(async (_cookieHeader: string, _returnUrl: string) => ({} as unknown)),
    logToAxiom: vi.fn(async (_data: Record<string, unknown>) => undefined as unknown),
    logAxiomError: vi.fn(
      async (_error: unknown, _extra?: Record<string, unknown>) => undefined as unknown
    ),
    releaseLeasesAtBoot: vi.fn(async () => 0),
  }));

vi.mock('$lib/server/page-access', () => ({ loadPageAccessGrants }));
vi.mock('$lib/server/auth', () => ({ guard: { check: guardCheck } }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom, logAxiomError }));
vi.mock('$lib/server/text-scan-tests/deps', () => ({ releaseLeasesAtBoot }));

const { init } = await import('../hooks.server');

beforeEach(() => vi.clearAllMocks());

describe('init', () => {
  it("releases this host's test-run leases at boot", async () => {
    await init();
    expect(releaseLeasesAtBoot).toHaveBeenCalledOnce();
  });

  it('never fails the boot when the moderator database is unreachable', async () => {
    releaseLeasesAtBoot.mockRejectedValueOnce(
      new Error('MODERATOR_DATABASE_URL is not configured')
    );
    await expect(init()).resolves.toBeUndefined();
    expect(logAxiomError).toHaveBeenCalledOnce();
  });
});
