import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as ReportController from '~/server/controllers/report.controller';
import type * as SiteAppealService from '~/server/services/site-appeal.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const flags = vi.hoisted(() => ({ siteAppealForm: true }));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: vi.fn(() => flags),
}));
vi.mock('~/server/services/site-appeal.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SiteAppealService>()),
  getSiteAppealState: vi.fn(async () => 'state'),
  submitSiteAppeal: vi.fn(async () => 'submitted'),
}));
vi.mock('~/server/controllers/report.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportController>()),
  createEntityAppealHandler: vi.fn(async () => 'in-app appeal'),
  getRecentAppealsHandler: vi.fn(async () => 0),
}));

const { reportRouter } = await import('~/server/routers/report.router');
const { createCallerFactory } = await import('~/server/trpc');
const { submitSiteAppeal } = await import('~/server/services/site-appeal.service');

const call = createCallerFactory(reportRouter);

const MEMBER = {
  id: 41,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
  bannedAt: null,
  deletedAt: null,
  muted: false,
};
const BANNED = { ...MEMBER, bannedAt: new Date('2026-10-01') };
const MUTED = { ...MEMBER, muted: true };
// Banned accounts are often ones that never finished onboarding.
const BANNED_NOT_ONBOARDED = { ...BANNED, onboarding: 0 };

function ctx(user: Record<string, unknown> | null) {
  return {
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {},
    track: { action: vi.fn(async () => undefined) },
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
  } as never;
}

const submission = {
  category: 'Account',
  message: 'I think this ban was a mistake, here is why.',
} as const;

beforeEach(() => {
  flags.siteAppealForm = true;
  vi.mocked(submitSiteAppeal).mockClear();
});

describe('site appeal procedures', () => {
  it.each([
    ['a banned account', BANNED],
    ['a muted account', MUTED],
    ['a banned account that never finished onboarding', BANNED_NOT_ONBOARDED],
    ['an unrestricted account', MEMBER],
  ])('let %s submit and read', async (_, user) => {
    await expect(call(ctx(user)).submitSiteAppeal(submission)).resolves.toBe('submitted');
    await expect(call(ctx(user)).getSiteAppealState()).resolves.toBe('state');
  });

  it('submit as the session user, never anyone named in the input', async () => {
    await call(ctx(BANNED)).submitSiteAppeal({ ...submission, userId: 999 } as never);
    expect(vi.mocked(submitSiteAppeal).mock.calls[0][0].user.id).toBe(BANNED.id);
  });

  it.each([
    ['signed out', null],
    ['deleted', { ...MEMBER, deletedAt: new Date('2026-10-01') }],
  ])('refuse an account that is %s', async (_, user) => {
    await expect(call(ctx(user)).submitSiteAppeal(submission)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(call(ctx(user)).getSiteAppealState()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuse everyone while the flag is off', async () => {
    flags.siteAppealForm = false;
    await expect(call(ctx(MEMBER)).submitSiteAppeal(submission)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(call(ctx(BANNED)).getSiteAppealState()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  // The other side of the same claim: the accounts let through above are still refused by the
  // procedures beside them, so the pass is the new procedure's doing, not a fixture that the
  // normal gates happen to accept.
  it('leave the neighbouring appeal procedures refusing banned and muted accounts', async () => {
    await expect(
      call(ctx(MUTED)).createAppeal({ entityType: 'Image', entityId: 1, message: 'm' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(call(ctx(BANNED)).getRecentAppeals({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      call(ctx(MEMBER)).createAppeal({ entityType: 'Image', entityId: 1, message: 'm' })
    ).resolves.toBe('in-app appeal');
  });
});

describe('restrictedAccountAppealProcedure', () => {
  const SERVER_DIR = path.join(__dirname, '../..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : walk(full);
      return /\.tsx?$/.test(name) ? [full] : [];
    });

  it('is built on by the site appeal form procedures and nothing else', () => {
    const uses = walk(SERVER_DIR).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/(\w+):\s*restrictedAccountAppealProcedure\b/g)].map(
        (m) => `${path.relative(SERVER_DIR, file).replace(/\\/g, '/')}#${m[1]}`
      );
    });
    expect(uses.sort()).toEqual([
      'routers/report.router.ts#getSiteAppealState',
      'routers/report.router.ts#submitSiteAppeal',
    ]);

    // Any other reference (a re-export, a `.use` chain, an alias) would escape the match above.
    const references = walk(SERVER_DIR).filter((file) =>
      readFileSync(file, 'utf8').includes('restrictedAccountAppealProcedure')
    );
    expect(references.map((f) => path.relative(SERVER_DIR, f).replace(/\\/g, '/')).sort()).toEqual([
      'routers/report.router.ts',
      'trpc.ts',
    ]);
    // In trpc.ts, only its own declaration: a second procedure built on it there would pass above.
    const trpcText = readFileSync(path.join(SERVER_DIR, 'trpc.ts'), 'utf8');
    expect(trpcText.match(/\brestrictedAccountAppealProcedure\b/g)).toHaveLength(1);
  });
});

// `rateLimit` passes everything through under test, so its presence on the submit procedure (the
// abuse control on a form open to banned accounts) can only be read off the source. The whole
// chain, anchored from the procedure name to its mutation, so a limit moved elsewhere fails.
it('rate-limits submitSiteAppeal, and only by successful submits, with its write scope', () => {
  const routerText = readFileSync(path.join(__dirname, '../report.router.ts'), 'utf8');
  const chain = routerText.match(
    /submitSiteAppeal: restrictedAccountAppealProcedure[\s\S]*?\.mutation\(/
  )?.[0];
  expect(chain).toBe(
    [
      'submitSiteAppeal: restrictedAccountAppealProcedure',
      '    .meta({ requiredScope: TokenScope.SocialWrite })',
      '    .input(submitSiteAppealSchema)',
      '    .use(rateLimit({ limit: 5, period: CacheTTL.day }, undefined, { onlyCountSuccess: true }))',
      '    .mutation(',
    ].join('\n')
  );
});
