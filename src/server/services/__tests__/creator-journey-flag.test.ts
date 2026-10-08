import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => false),
  isFliptSync: vi.fn((): boolean | null => null),
  getFliptClientSync: vi.fn((): unknown => null),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mocks.isFlipt,
  isFliptSync: mocks.isFliptSync,
  ensureFliptInitialized: mocks.ensureFliptInitialized,
  getFliptClientSync: mocks.getFliptClientSync,
}));

import type * as FliptClient from '~/server/flipt/client';
import type { SessionUser } from '~/types/session';
import {
  creatorJourneyAudience,
  isCreatorJourneyFlagReadable,
  isCreatorJourneyOnFor,
  isCreatorJourneyPublic,
} from '~/server/services/creator-journey-flag.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';

/**
 * A creator-journey flag that does not exist yet, or a Flipt that cannot answer, must leave Creator
 * Journey on for moderators and off for everyone else on both paths: the session registry (page,
 * menu, procs) and the off-session evaluation the nightly job uses.
 */

const MIGRATION = join(
  process.cwd(),
  'packages/civitai-db-schema/prisma/migrations/20261005120000_creator_milestone/migration.sql'
);
const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY, meta jsonb, "isModerator" boolean NOT NULL DEFAULT false,
      "deletedAt" timestamp(3), "bannedAt" timestamp(3)
    );
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY);
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
  await holder.db.exec(`
    INSERT INTO "User" (id, meta, "isModerator", "bannedAt") VALUES
      (1, '{"scores":{"total":600}}', false, NULL),
      (2, '{"scores":{"total":600}}', true, NULL),
      (3, '{"scores":{"total":100}}', false, NULL),
      (4, '{"scores":{"total":600}}', false, NULL),
      (5, '{"scores":{"total":600}}', false, now());
    INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey") VALUES (4, 'score:spark');
  `);
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isFlipt.mockResolvedValue(false);
  mocks.isFliptSync.mockReturnValue(null);
});

describe('creator journey flag for a user who is not the session user', () => {
  it('is on for a moderator without asking Flipt', async () => {
    expect(await isCreatorJourneyOnFor({ id: 2, isModerator: true })).toBe(true);
    expect(mocks.isFlipt).not.toHaveBeenCalled();
  });

  it('asks Flipt about anyone else, with only what the testers segment matches on', async () => {
    mocks.isFlipt.mockResolvedValue(true);
    expect(await isCreatorJourneyOnFor({ id: 1, isModerator: false })).toBe(true);
    expect(mocks.isFlipt).toHaveBeenCalledWith('creator-journey', '1', {
      userId: '1',
      isModerator: 'false',
    });
  });

  it('is off for everyone else while the flag is missing or Flipt cannot answer', async () => {
    expect(await isCreatorJourneyOnFor({ id: 1, isModerator: false })).toBe(false);
    expect(await isCreatorJourneyPublic()).toBe(false);
  });

  it('asks whether it is public as someone in no segment', async () => {
    mocks.isFlipt.mockResolvedValue(true);
    expect(await isCreatorJourneyPublic()).toBe(true);
    expect(mocks.isFlipt).toHaveBeenCalledWith('creator-journey', '0', {
      userId: '0',
      isModerator: 'false',
    });
  });
});

describe('creatorJourneyAudience', () => {
  it('evaluates only users still owed a tier, and keeps those the flag is on for', async () => {
    mocks.isFlipt.mockImplementation(async (_key: string, entityId: string) => entityId === '1');
    const audience = await creatorJourneyAudience(pg, [1, 2, 3, 4, 5]);
    expect([...audience].sort()).toEqual([1, 2]);
    // 3 has no tier, 4 already holds it, 5 is banned; 2 is a moderator.
    expect(mocks.isFlipt.mock.calls.map(([, entityId]) => entityId)).toEqual(['1']);
  });

  it('keeps only moderators while the flag is missing', async () => {
    expect([...(await creatorJourneyAudience(pg, [1, 2]))]).toEqual([2]);
  });
});

describe('creatorJourney in the session registry while Flipt cannot answer', () => {
  it('is on for a moderator and off for a signed-in user', async () => {
    const mod = { id: 9101, isModerator: true, tier: 'free' } as SessionUser;
    const user = { id: 9202, isModerator: false, tier: 'free' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user: mod })).creatorJourney).toBe(true);
    expect(mocks.isFliptSync).toHaveBeenCalledWith('creator-journey', '9101', expect.anything());
    expect((await getFeatureFlagsAsync({ user })).creatorJourney).toBeFalsy();
  });

  it('follows Flipt once it answers', async () => {
    mocks.isFliptSync.mockReturnValue(true);
    const tester = { id: 9303, isModerator: false, tier: 'free' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user: tester })).creatorJourney).toBe(true);
  });
});

describe('isCreatorJourneyFlagReadable', () => {
  const evaluating = (evaluateBoolean: () => unknown) => ({
    evaluateBoolean: vi.fn(evaluateBoolean),
  });

  it('initialises the client before asking for it', async () => {
    let initialised = false;
    mocks.ensureFliptInitialized.mockImplementationOnce(async () => {
      initialised = true;
    });
    mocks.getFliptClientSync.mockImplementation(() =>
      initialised ? evaluating(() => ({ enabled: false })) : null
    );
    expect(await isCreatorJourneyFlagReadable()).toBe(true);
  });

  it('is false while the Flipt client has not initialised', async () => {
    mocks.getFliptClientSync.mockReturnValue(null);
    expect(await isCreatorJourneyFlagReadable()).toBe(false);
  });

  // isFlipt turns "flag not found" into false, which would read as the flag being off for everyone:
  // deleting the flag before its readers would strip every tester's Discord roles.
  it('is false when the flag is missing from an initialised client', async () => {
    mocks.getFliptClientSync.mockReturnValue(
      evaluating(() => {
        throw new Error('flag not found');
      })
    );
    expect(await isCreatorJourneyFlagReadable()).toBe(false);
  });

  it('is true when the flag evaluates, whatever it answers', async () => {
    const client = evaluating(() => ({ enabled: false }));
    mocks.getFliptClientSync.mockReturnValue(client);
    expect(await isCreatorJourneyFlagReadable()).toBe(true);
    expect(client.evaluateBoolean).toHaveBeenCalledWith(
      expect.objectContaining({ flagKey: 'creator-journey' })
    );
  });
});
