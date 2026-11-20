import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Registry from '~/server/services/remix-app-registry.service';
import type * as RunService from '~/server/services/remix-app-run.service';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';

/**
 * `remixApp.admin.*` through the real router and middleware: only a moderator with the remix apps
 * flag reaches the writes, and a row that does not validate never reaches them either.
 */

const h = vi.hoisted(() => ({
  save: vi.fn(),
  setEnabled: vi.fn(),
  order: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
}));
// Not in `h`, whose mocks the first test counts.
const u = vi.hoisted(() => ({
  submit: vi.fn(),
  review: vi.fn(),
  clear: vi.fn(),
  validate: vi.fn(),
}));

vi.mock('~/server/services/remix-app-registry.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Registry>()),
  saveRemixApp: h.save,
  setRemixAppEnabled: h.setEnabled,
  orderRemixApps: h.order,
  deleteRemixApp: h.remove,
  listRemixAppsForAdmin: h.list,
  submitUserRemixApp: u.submit,
  reviewUserRemixApp: u.review,
  clearRemixMinorThemed: u.clear,
  validateUserRemixApp: u.validate,
}));
vi.mock('~/server/services/remix-app-run.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RunService>()),
  startRemixRun: h.start,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));
vi.mock('~/server/middleware.trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof MiddlewareTrpc>()),
  rateLimit:
    () =>
    async ({ next }: { next: () => unknown }) =>
      next(),
}));

const { remixAppRouter } = await import('~/server/routers/remix-app.router');

const user = { id: 4127, isModerator: false, muted: false, onboarding: OnboardingSteps.Buzz };
const moderator = { ...user, id: 88, isModerator: true };
// Per-request flags, so a test can turn the flag off for a moderator (its default audience).
const ctx = (who: object, features: object = { trpcFlagGuardPerRequest: true, remixApps: true }) =>
  ({
    user: who,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features,
    track: {},
  } as never);
const as = (who: object, features?: object) =>
  remixAppRouter.createCaller(ctx(who, features)).admin;

const restyle = SEED_REMIX_APPS.find((app) => app.slug === 'restyle')!;
// A function: tRPC adds `browsingLevel` to the input object it is given.
const tap = () => ({ slug: 'restyle', imageId: 5, nonce: 'nonce-test' });

beforeEach(() => {
  vi.clearAllMocks();
  h.save.mockResolvedValue({ slug: 'restyle', version: 1 });
  h.list.mockResolvedValue([]);
  h.start.mockResolvedValue({ status: 'priced', runId: 'r', cost: 30, ready: true });
});

describe('remixApp.admin', () => {
  it('refuses every action to a non-moderator, before any service runs', async () => {
    const calls = [
      () => as(user).list(),
      () => as(user).save({ ...restyle }),
      () => as(user).setEnabled({ slug: 'restyle', enabled: false }),
      () => as(user).order({ slugs: ['restyle'] }),
      () => as(user).delete({ slug: 'test-charcoal' }),
      () => as(user).testStart({ ...tap(), quote: 30 }),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();

    // POSITIVE CONTROL: the same calls as a moderator reach the services.
    await as(moderator).list();
    await as(moderator).save({ ...restyle });
    await as(moderator).setEnabled({ slug: 'restyle', enabled: false });
    await as(moderator).order({ slugs: ['restyle'] });
    await as(moderator).delete({ slug: 'test-charcoal' });
    await as(moderator).testStart({ ...tap(), quote: 30 });
    for (const fn of Object.values(h)) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refuses a moderator while the remix apps flag is off', async () => {
    await expect(
      as(moderator, { trpcFlagGuardPerRequest: true }).save({ ...restyle })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.save).not.toHaveBeenCalled();
    // POSITIVE CONTROL: with the flag on, the same save goes through.
    await as(moderator).save({ ...restyle });
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an engine no remix app runs on',
      { engine: { safe: { ecosystem: 'Flux2', versionId: 2439067 } } },
    ],
    [
      'a model version the engine does not have',
      { engine: { safe: { ecosystem: 'NanoBanana', versionId: 1 } } },
    ],
    [
      'a prompt naming no ask',
      {
        steps: [
          {
            kind: 'image',
            prompt: 'Draw {{mood}}',
            aspectRatio: 'source',
            quantity: 1,
            input: 'source',
          },
        ],
      },
    ],
    [
      'the mature engine on safe sources, which no provider policy covers',
      {
        engine: {
          safe: {
            ecosystem: REMIX_ENGINES.edit.mature.ecosystemKey,
            versionId: REMIX_ENGINES.edit.mature.modelVersionId,
          },
        },
      },
    ],
    ['a field the schema does not know', { webhook: 'https://example.com' }],
    ['an upscale with nothing before it', { steps: [{ kind: 'upscale', scale: 2 }] }],
  ])('refuses a row with %s, before it is saved', async (_, over) => {
    const spec = { ...(restyle.spec as object), ...over };
    await expect(as(moderator).save({ ...restyle, spec } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('refuses a user app spec, which only submit writes', async () => {
    const { engine } = restyle.spec as { engine: unknown };
    const spec = { icon: 'sparkles', engine, source: 'export default 1' };
    await expect(as(moderator).save({ ...restyle, spec } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('test-runs any app, disabled ones too, and passes no quote until one is confirmed', async () => {
    await as(moderator).testStart(tap());
    expect(h.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...tap(), allowDisabled: true })
    );
    expect(h.start.mock.lastCall![0].quote).toBeUndefined();
    await as(moderator).testStart({ ...tap(), quote: 30 });
    expect(h.start).toHaveBeenLastCalledWith(expect.objectContaining({ quote: 30 }));
  });
});

describe('user app code: submit and review', () => {
  const flags = (more: object) => ({ trpcFlagGuardPerRequest: true, remixApps: true, ...more });
  const submission = () => ({
    name: 'probe',
    title: 'Probe',
    icon: 'sparkles' as const,
    source: 'export default 1',
  });
  const decision = () => ({
    slug: 'u88-probe',
    sha256: 'a'.repeat(64),
    seenReview: 'submitted' as const,
    decision: 'approved' as const,
  });

  it('lists user apps only with remixAppsUserCode on', async () => {
    h.list.mockResolvedValue([
      { slug: 'restyle', input: {} },
      { slug: 'u88-probe', user: {} },
      // A user row whose manifest no longer validates carries no `user`.
      { slug: 'u88-broken', invalid: ['remix: Required'] },
    ]);
    expect(await as(moderator).list()).toEqual([{ slug: 'restyle', input: {} }]);
    // POSITIVE CONTROL: with the flag, the user apps are listed too.
    expect(await as(moderator, flags({ remixAppsUserCode: true })).list()).toHaveLength(3);
  });

  it('submits only with remixAppsUserCode and remixAppBuilder both on, always as the caller', async () => {
    for (const features of [flags({ remixAppsUserCode: true }), flags({ remixAppBuilder: true })])
      await expect(
        remixAppRouter.createCaller(ctx(moderator, features)).submit(submission())
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(u.submit).not.toHaveBeenCalled();

    // POSITIVE CONTROL: with both on it reaches the service, and an authorId in the input is dropped.
    const both = flags({ remixAppsUserCode: true, remixAppBuilder: true });
    await remixAppRouter
      .createCaller(ctx(moderator, both))
      .submit({ ...submission(), authorId: 1 } as never);
    expect(u.submit).toHaveBeenCalledWith(expect.objectContaining({ authorId: moderator.id }));
    await remixAppRouter
      .createCaller(ctx(moderator, both))
      .submit({ ...submission(), reviewLog: [], minorThemed: null, review: 'approved' } as never);
    const sent = u.submit.mock.calls.at(-1)![0] as object;
    for (const key of ['reviewLog', 'minorThemed', 'review']) expect(sent).not.toHaveProperty(key);
  });

  it('reviews only as a moderator with remixAppsUserCode on', async () => {
    await expect(as(moderator).review(decision())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const on = flags({ remixAppsUserCode: true });
    await expect(as(user, on).review(decision())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(u.review).not.toHaveBeenCalled();

    // POSITIVE CONTROL: a moderator with the flag reaches the service, named as the reviewer.
    await as(moderator, on).review(decision());
    expect(u.review).toHaveBeenCalledWith(expect.objectContaining({ moderatorId: moderator.id }));
  });

  it('dry-runs a user app only as a moderator with remixAppsUserCode on', async () => {
    const on = flags({ remixAppsUserCode: true });
    await expect(as(moderator).validate({ slug: 'u88-probe' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(as(user, on).validate({ slug: 'u88-probe' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(u.validate).not.toHaveBeenCalled();
    // POSITIVE CONTROL: a moderator with the flag reaches the service.
    await as(moderator, on).validate({ slug: 'u88-probe' });
    expect(u.validate).toHaveBeenCalledWith('u88-probe');
  });

  it('clears a minor-themed mark only as a moderator with remixAppsUserCode on', async () => {
    const on = flags({ remixAppsUserCode: true });
    await expect(as(moderator).clearMinorThemed({ slug: 'u88-probe' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(as(user, on).clearMinorThemed({ slug: 'u88-probe' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(u.clear).not.toHaveBeenCalled();
    await as(moderator, on).clearMinorThemed({ slug: 'u88-probe' });
    expect(u.clear).toHaveBeenCalledWith({ slug: 'u88-probe', moderatorId: moderator.id });
  });

  it("toggles or deletes a user app's row only with remixAppsUserCode on, as a named moderator", async () => {
    await expect(
      as(moderator).setEnabled({ slug: 'u88-probe', enabled: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as(moderator).delete({ slug: 'u88-probe' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(h.setEnabled).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();

    const on = flags({ remixAppsUserCode: true });
    await as(moderator, on).setEnabled({ slug: 'u88-probe', enabled: false });
    expect(h.setEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'u88-probe', moderatorId: moderator.id })
    );
    await as(moderator, on).delete({ slug: 'u88-probe' });
    expect(h.remove).toHaveBeenCalledWith({ slug: 'u88-probe' });
  });
});
