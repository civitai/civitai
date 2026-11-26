import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import '~/__tests__/setup';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';

/**
 * The block consent mirror writes `scope` and `buzzLimit` on the shared "OauthConsent" row. A
 * recipe runner's offline cap (`offlineBuzzLimit`/`offlineBuzzPeriod`) and its grant sit on the
 * same row, and only the hub's consent flow may change them: the mirror's real upsert, run against
 * Postgres here, must leave them as they were.
 */

import { dbMock } from '~/__tests__/mocks';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { writeOauthConsent } from '../oauth-consent-sync.service';

const USER_ID = 7;
const CLIENT_ID = 'recipe-runner';
const GRANTED = new Date('2026-11-20T12:00:00.000Z');

let h: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  h = await startPglitePrisma(`
    CREATE TABLE "OauthConsent" (
      id SERIAL PRIMARY KEY, "userId" int NOT NULL, "clientId" text NOT NULL, scope bigint NOT NULL,
      "buzzLimit" jsonb, "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      "updatedAt" timestamp(3) NOT NULL DEFAULT now(), "offlineGrantedAt" timestamp(3),
      "offlineBuzzLimit" int, "offlineBuzzPeriod" text,
      UNIQUE ("userId", "clientId")
    );
  `);
});
afterAll(() => h?.stop());

beforeEach(async () => {
  await h.pg.exec(`DELETE FROM "OauthConsent"`);
  const consent = h.prisma.oauthConsent;
  dbMock.dbWrite.oauthConsent.findUnique.mockImplementation(((a: never) =>
    consent.findUnique(a)) as never);
  dbMock.dbWrite.oauthConsent.upsert.mockImplementation(((a: never) => consent.upsert(a)) as never);
});

const offlineColumns = async () =>
  (
    await h.pg.query<Record<string, unknown>>(
      `SELECT "offlineGrantedAt", "offlineBuzzLimit", "offlineBuzzPeriod", scope::text AS scope
       FROM "OauthConsent" WHERE "userId" = $1 AND "clientId" = $2`,
      [USER_ID, CLIENT_ID]
    )
  ).rows[0];

describe('writeOauthConsent (the block consent mirror)', () => {
  it('leaves the offline grant and the runner cap alone when it rewrites scope and buzzLimit', async () => {
    await h.pg.query(
      `INSERT INTO "OauthConsent" ("userId", "clientId", scope, "offlineGrantedAt", "offlineBuzzLimit", "offlineBuzzPeriod")
       VALUES ($1, $2, 1, $3, 500, 'week')`,
      [USER_ID, CLIENT_ID, GRANTED]
    );
    await writeOauthConsent({
      userId: USER_ID,
      clientId: CLIENT_ID,
      scope: TokenScope.UserRead | TokenScope.ModelsRead,
      // Unchanged (null), so no orchestrator cache bust leaves the process.
      buzzLimit: null,
    });
    expect(await offlineColumns()).toEqual({
      // The write landed (control): the scope changed.
      scope: String(TokenScope.UserRead | TokenScope.ModelsRead),
      offlineGrantedAt: GRANTED,
      offlineBuzzLimit: 500,
      offlineBuzzPeriod: 'week',
    });
  });
});
