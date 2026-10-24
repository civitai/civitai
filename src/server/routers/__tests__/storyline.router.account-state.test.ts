import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorylineService from '~/server/services/storyline.service';
import type * as StorylineCaptionService from '~/server/services/storyline-caption.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * A muted or banned account cannot write to a storyline: start one, edit it, add or insert a
 * chapter, pick the canon branch, join two branches, add or remove a collaborator, or caption a
 * chapter image.
 *
 * Every one of those changes what other people read or who can post into the story, so a muted
 * owner must not be able to steer a public story or hand posting rights around.
 *
 * Asserted at the ROUTER, because the refusal is a property of the procedure the mutation is built
 * from — nothing inside the services would change if the wrapper were swapped back.
 */

const writers = vi.hoisted(() => ({
  createStoryline: vi.fn(async () => ({ id: 1 })),
  updateStoryline: vi.fn(async () => ({ id: 1 })),
  addOwnerChapter: vi.fn(async () => ({ id: 1 })),
  insertStorylineChapter: vi.fn(async () => ({ chapterId: 1 })),
  setCanonChapter: vi.fn(async () => ({ id: 1 })),
  linkStorylineChapter: vi.fn(async () => ({ id: 1 })),
  addStorylineCollaborator: vi.fn(async () => ({ id: 1 })),
  removeStorylineCollaborator: vi.fn(async () => ({ id: 1 })),
  setStorylineTakedown: vi.fn(async () => ({ id: 1 })),
  setStorylineImageCaption: vi.fn(async () => null),
}));

// Spread the real module and override only the writers: a hand-listed mock would couple this test
// to every export the router happens to import today.
vi.mock('~/server/services/storyline.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylineService>()),
  ...writers,
}));
vi.mock('~/server/services/storyline-caption.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylineCaptionService>()),
  setStorylineImageCaption: writers.setStorylineImageCaption,
}));

import { storylineRouter } from '~/server/routers/storyline.router';
import { guardedProcedure } from '~/server/trpc';

const WRITE_CALLS = [
  {
    name: 'create',
    writer: writers.createStoryline,
    input: { postId: 11, title: 'A story', maxNsfwLevel: 1 },
  },
  { name: 'update', writer: writers.updateStoryline, input: { id: 10, title: 'Renamed' } },
  {
    name: 'addChapter',
    writer: writers.addOwnerChapter,
    input: { parentChapterId: 3, postId: 12 },
  },
  {
    name: 'insertChapter',
    writer: writers.insertStorylineChapter,
    input: { storylineId: 10, parentChapterId: 3, childChapterId: 4, postId: 12 },
  },
  { name: 'setCanon', writer: writers.setCanonChapter, input: { chapterId: 3 } },
  {
    name: 'linkChapter',
    writer: writers.linkStorylineChapter,
    input: { parentChapterId: 3, chapterId: 7 },
  },
  {
    name: 'addCollaborator',
    writer: writers.addStorylineCollaborator,
    input: { storylineId: 10, userId: 77 },
  },
  {
    name: 'removeCollaborator',
    writer: writers.removeStorylineCollaborator,
    input: { storylineId: 10, userId: 77 },
  },
  {
    name: 'setImageCaption',
    writer: writers.setStorylineImageCaption,
    input: { imageId: 40, content: 'A note' },
  },
] as const;

type ProcedureDef = { _def: { type: string; middlewares: unknown[] } };

const procedures = (storylineRouter as unknown as { _def: { procedures: Record<string, unknown> } })
  ._def.procedures as Record<string, ProcedureDef>;

const guardedMiddlewares = (guardedProcedure as unknown as ProcedureDef)._def.middlewares;

/** Whether a procedure is built from `guardedProcedure` — its chain, not its name. */
const isGuarded = (procedure: ProcedureDef) =>
  guardedMiddlewares.every((middleware, index) => procedure._def.middlewares[index] === middleware);

const mutationNames = Object.entries(procedures)
  .filter(([, procedure]) => procedure._def.type === 'mutation')
  .map(([name]) => name);

// Each state names the middleware that refuses it. Both throw FORBIDDEN, so the code alone cannot
// say which gate fired — a call refused for the wrong reason would otherwise read as a working mute.
// Only `muted` tells guardedProcedure from protectedProcedure: a ban is refused by both, so the
// banned cases pin that a ban stays refused, not that these mutations are guarded.
const REFUSED_STATES = [
  { state: 'muted', user: { muted: true }, message: /restricted/i },
  { state: 'banned', user: { bannedAt: new Date('2026-01-01') }, message: /banned/i },
] as const;

function callerFor(user: Record<string, unknown> = {}) {
  return storylineRouter.createCaller({
    user: {
      id: 1,
      permissions: ['storylines'],
      isModerator: false,
      muted: false,
      bannedAt: null,
      // The finished wizard, so an unset onboarding bit cannot be what refuses the call.
      onboarding: OnboardingSteps.Buzz,
      ...user,
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: true, isGreen: false },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
}

beforeEach(() => vi.clearAllMocks());

describe('storyline router — account state refuses a storyline write', () => {
  /**
   * The load-bearing case: exactly the storyline-writing mutations are built from
   * `guardedProcedure`, read off each procedure's middleware chain. A new write mutation added
   * without the guard, or one of these reverted to `protectedProcedure`, fails here.
   */
  it('guards exactly the storyline-writing mutations', () => {
    expect(guardedMiddlewares.length).toBeGreaterThan(0);
    expect(mutationNames.length).toBeGreaterThan(WRITE_CALLS.length);

    const guarded = mutationNames.filter((name) => isGuarded(procedures[name]));

    expect(guarded.sort()).toEqual(WRITE_CALLS.map((call) => call.name).sort());
  });

  for (const { name, writer, input } of WRITE_CALLS) {
    for (const { state, user, message } of REFUSED_STATES) {
      it(`refuses a ${state} user on ${name}`, async () => {
        await expect(callerFor(user)[name](input)).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: expect.stringMatching(message),
        });
        expect(writer).not.toHaveBeenCalled();
      });
    }

    // The control: the refusals prove nothing unless the same call reaches the service for an
    // account in neither state — a broken input shape refuses everywhere and reads as a guard.
    it(`lets an ordinary user through on ${name}`, async () => {
      await expect(callerFor()[name](input)).resolves.toBeDefined();
      expect(writer).toHaveBeenCalledTimes(1);
    });
  }
});

describe('storyline router — stepping down and taking down', () => {
  // Removal is guarded because it changes someone else's access. A collaborator can be added
  // without being asked, so stepping down must stay open to a muted one.
  it('lets a muted collaborator leave, and only ever removes the caller', async () => {
    await expect(
      callerFor({ id: 8, muted: true }).leave({ storylineId: 10, userId: 77 })
    ).resolves.toBeDefined();
    expect(writers.removeStorylineCollaborator).toHaveBeenCalledWith({
      storylineId: 10,
      targetUserId: 8,
      userId: 8,
    });
  });

  it('refuses a banned collaborator leaving, as every signed-in call does', async () => {
    await expect(
      callerFor({ id: 8, bannedAt: new Date('2026-01-01') }).leave({ storylineId: 10 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/banned/i) });
  });

  it('lets only a moderator take a storyline down', async () => {
    await expect(callerFor().setTakedown({ id: 10, takenDown: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(writers.setStorylineTakedown).not.toHaveBeenCalled();

    await callerFor({ isModerator: true }).setTakedown({ id: 10, takenDown: true });
    expect(writers.setStorylineTakedown).toHaveBeenCalledWith({ id: 10, takenDown: true });
  });
});
