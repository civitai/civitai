import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SpendCap from '../spend-cap';

/**
 * The daily dollar cap as a moderator meets it: whether a question is let in, and how many tokens the
 * turn may then spend. The cap's resolution and the price are the real ones; only the rows are faked.
 */

const { usdToday, tokensToday, capsFor } = vi.hoisted(() => ({
  usdToday: vi.fn(),
  tokensToday: vi.fn(),
  capsFor: vi.fn(),
}));

vi.mock('../../xguard-api', () => ({ openrouterKey: () => 'test-key' }));
vi.mock('../tools', () => ({ LOOKUP: '/lookup', toolSpec: () => ({}), toolsFor: () => [] }));
vi.mock('../store', () => ({
  DEFAULT_CHAT_TITLE: 'New chat',
  getChat: vi.fn(async () => ({ title: 'c', seedUserId: null, seedReportId: null })),
  hasRunningTurn: vi.fn(async () => false),
  usdToday,
  tokensToday,
}));
vi.mock('../spend-cap', async (importOriginal) => ({
  ...(await importOriginal<typeof SpendCap>()),
  capsFor,
}));

const { admitTurn, remainingTokens } = await import('../turn.service');
const { DAILY_TOKEN_CAP } = await import('../loop');

const moderator = { id: 7, roles: ['moderator:mod-high-access'] };

beforeEach(() => {
  usdToday.mockReset().mockResolvedValue(0);
  tokensToday.mockReset().mockResolvedValue(0);
  capsFor.mockReset().mockResolvedValue([]);
});

describe('admitTurn', () => {
  it('refuses at the cap and admits one cent under it', async () => {
    capsFor.mockResolvedValue([{ scope: 'role', subject: 'moderator:mod-high-access', usd: 2 }]);
    usdToday.mockResolvedValue(2);
    expect(await admitTurn(1, moderator)).toMatchObject({ ok: false, status: 429 });
    usdToday.mockResolvedValue(1.99);
    expect(await admitTurn(1, moderator)).toMatchObject({
      ok: true,
      allowance: { spentUsd: 1.99, capUsd: 2 },
    });
  });

  it('refuses a moderator whose own cap is $0, whatever their role allows', async () => {
    capsFor.mockResolvedValue([
      { scope: 'role', subject: 'moderator:mod-high-access', usd: 50 },
      { scope: 'user', subject: '7', usd: 0 },
    ]);
    expect(await admitTurn(1, moderator)).toMatchObject({ ok: false, status: 429 });
  });

  it('holds a moderator with no cap anywhere to the $1 default', async () => {
    usdToday.mockResolvedValue(1);
    expect(await admitTurn(1, moderator)).toMatchObject({ ok: false, status: 429 });
    usdToday.mockResolvedValue(0.99);
    expect(await admitTurn(1, moderator)).toMatchObject({ ok: true });
  });

  it('refuses past the token circuit breaker even with dollars left', async () => {
    capsFor.mockResolvedValue([{ scope: 'user', subject: '7', usd: 1000 }]);
    tokensToday.mockResolvedValue(DAILY_TOKEN_CAP);
    expect(await admitTurn(1, moderator)).toMatchObject({ ok: false, status: 429 });
  });
});

describe('remainingTokens', () => {
  it('converts the dollars left at the dearer direction of the price', () => {
    // $0.27 left at $1 in / $2.70 out per million: 100k tokens, not the 270k the input price allows.
    expect(
      remainingTokens({ spentUsd: 0.73, capUsd: 1, usedTokens: 0 }, { input: 1, output: 2.7 })
    ).toBe(100_000);
  });

  it('never exceeds what the circuit breaker leaves', () => {
    expect(
      remainingTokens(
        { spentUsd: 0, capUsd: 1000, usedTokens: DAILY_TOKEN_CAP - 10 },
        { input: 0.01, output: 0.01 }
      )
    ).toBe(10);
  });
});
