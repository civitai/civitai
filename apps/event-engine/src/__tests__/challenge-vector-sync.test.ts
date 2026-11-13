import { describe, expect, test } from 'vitest';
import { challengeDomain, challengeRefFromEvent } from '@/vector-sync/challenges/domain';
import { getChallengeDocs } from '@/vector-sync/challenges/source';

// Eligibility itself is pinned to the site's rule by the site's challenge-eligibility parity test.
describe('challenge payload, against the real query', () => {
  test('carries the fields the site filters on, both levels as bits', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
      CREATE TYPE "ChallengeStatus" AS ENUM ('Scheduled', 'Active', 'Completing', 'Completed', 'Cancelled');
      CREATE TYPE "ChallengeSource" AS ENUM ('System', 'Mod', 'User');
      CREATE TABLE "User" (id int PRIMARY KEY, username text);
      CREATE TABLE "Image" (id int PRIMARY KEY, "nsfwLevel" int, poi boolean, ingestion text);
      CREATE TABLE "ChallengeEvent" (id int PRIMARY KEY, title text);
      CREATE TABLE "Challenge" (id int PRIMARY KEY, title text, theme text, invitation text,
        description text, status "ChallengeStatus", source "ChallengeSource", "buzzType" text,
        "nsfwLevel" int, "modelVersionIds" int[], "eventId" int, "visibleAt" timestamp,
        "createdById" int, "coverImageId" int, ingestion text);
      INSERT INTO "User" VALUES (7, 'someone');
      INSERT INTO "Image" VALUES (70, 6, false, 'Scanned'), (80, NULL, false, 'Scanned');
      INSERT INTO "ChallengeEvent" VALUES (3, 'Winter <i>Fest</i>');
      INSERT INTO "Challenge" VALUES
        (1, 'Neon  Dreams', 'Neon', 'Come <b>glow</b>', '<p>Bright cities</p>', 'Active', 'User',
          'green', 3, '{11,12}', 3, '2026-01-01', 7, 70, 'Scanned'),
        (2, 'Gone', NULL, NULL, NULL, 'Cancelled', 'System', 'yellow', 1, '{}', NULL,
          '2026-01-01', NULL, 80, 'Scanned'),
        (3, 'Daily', NULL, NULL, NULL, 'Completed', 'System', 'yellow', 1, '{}', NULL,
          '2026-01-02', NULL, 80, 'Scanned');
    `);
    try {
      const docs = await getChallengeDocs(
        pg as unknown as Parameters<typeof getChallengeDocs>[0],
        [1, 2, 3]
      );
      expect([...docs.keys()].sort()).toEqual([1, 3]);
      expect(docs.get(1)).toMatchObject({
        title_normalized: 'neon dreams',
        title: 'Neon  Dreams',
        theme: 'Neon',
        status: 'Active',
        source: 'User',
        buzzType: 'green',
        nsfwLevel: [1, 2],
        coverNsfwLevel: [2, 4],
        modelVersionIds: [11, 12],
        eventId: 3,
        visibleAt: '2026-01-01T00:00:00.000Z',
        userId: 7,
        username: 'someone',
        coverImageId: 70,
      });
      expect(docs.get(1)?.search_text).toBe(
        'Title: Neon Dreams\nTheme: Neon\nInvitation: Come glow\nDescription: Bright cities\nEvent: Winter Fest'
      );
      // A system challenge has no creator; an unrated cover matches no browsing level.
      expect(docs.get(3)).toMatchObject({
        userId: null,
        username: null,
        eventId: null,
        coverNsfwLevel: [],
      });
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('challenge change signals', () => {
  test('a challenge row names itself; an event row names its challenges through eventId', () => {
    expect(challengeRefFromEvent('postgres.Challenge', { op: 'u', after: { id: 3 } })).toEqual({
      id: 3,
    });
    expect(
      challengeRefFromEvent('postgres.Challenge', { op: 'd', before: { id: 4 }, after: null })
    ).toEqual({ id: 4 });
    expect(challengeRefFromEvent('postgres.ChallengeEvent', { op: 'u', after: { id: 9 } })).toEqual(
      { child: 9 }
    );
    expect(challengeRefFromEvent('postgres.Challenge', { op: 'r', after: { id: 5 } })).toBeNull();
    expect(challengeDomain.childField).toBe('eventId');
  });
});

describe('challenge embedding switch', () => {
  test('stays off until VECTOR_CHALLENGE_EMBED_ENABLED is true, even with the global switch on', async () => {
    const { config, domainEmbedEnabled } = await import('@/config');
    const global = config.vectorSync.embedEnabled;
    const own = process.env.VECTOR_CHALLENGE_EMBED_ENABLED;
    try {
      config.vectorSync.embedEnabled = true;
      delete process.env.VECTOR_CHALLENGE_EMBED_ENABLED;
      expect(domainEmbedEnabled(challengeDomain.name, challengeDomain.embedByDefault)).toBe(false);
      process.env.VECTOR_CHALLENGE_EMBED_ENABLED = 'true';
      expect(domainEmbedEnabled(challengeDomain.name, challengeDomain.embedByDefault)).toBe(true);
    } finally {
      config.vectorSync.embedEnabled = global;
      if (own === undefined) delete process.env.VECTOR_CHALLENGE_EMBED_ENABLED;
      else process.env.VECTOR_CHALLENGE_EMBED_ENABLED = own;
    }
  });
});
