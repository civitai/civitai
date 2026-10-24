import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A moderator's Creator Services offering takedown from the report queue, on the real migrations
 * (including the CHECK that ties a recorded removal to status Removed). The main app's
 * `takedownServiceOffering` holds the same invariants; this is the second writer, so each one is
 * pinned here: one takedown per offering, a seller's own remove does not shield it, and the seller is
 * notified exactly once, never with the moderator.
 */

const { dbHandle, recordModActivity, createNotification } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  recordModActivity: vi.fn(),
  createNotification: vi.fn(async () => undefined),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../mod-activity', () => ({ recordModActivity }));
vi.mock('../notifications', () => ({ getNotifications: () => ({ createNotification }) }));

const { takedownServiceOffering, getReportServiceOfferingId, getReportedServiceOfferings } =
  await import('../service-offering-takedown.service');

const migration = (name: string) =>
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../../packages/civitai-db-schema/prisma/migrations',
      name,
      'migration.sql'
    ),
    'utf8'
  );

const SELLER = 1;
const MOD = 42;
const OFFERING = 1;

let pg: PGlite;

const offering = async () =>
  (
    await pg.query<{
      status: string;
      removedReason: string | null;
      removedDetails: string | null;
      removedById: number | null;
    }>(
      `SELECT status::text, "removedReason", "removedDetails", "removedById" FROM "ServiceOffering" WHERE id = $1`,
      [OFFERING]
    )
  ).rows[0];

const takeDown = (reason: 'spam' | 'misleading' = 'misleading', moderatorId = MOD) =>
  takedownServiceOffering({ offeringId: OFFERING, reason, details: 'Links off-site', moderatorId });

beforeEach(async () => {
  vi.clearAllMocks();
  pg = await freshPglite();
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, username text);
    CREATE TABLE "Report" (id serial PRIMARY KEY);
  `);
  await pg.exec(migration('20261025120000_creator_services_foundation'));
  await pg.exec(migration('20261028150000_creator_service_max_nsfw_level'));
  await pg.exec(migration('20261028170000_creator_service_offering_takedown'));
  await pg.exec(`
    INSERT INTO "User" (id, username) VALUES (${SELLER}, 'badgesmith');
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", status, "updatedAt")
      VALUES (${SELLER}, 'Custom badge', 'One animated badge', 1000, 3, 'Active', now());
    INSERT INTO "Report" DEFAULT VALUES;
    INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (${OFFERING}, 1);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('service offering takedown from the report queue', () => {
  it('finds the offering a report is about, and shows it with its seller', async () => {
    expect(await getReportServiceOfferingId(1)).toBe(OFFERING);
    expect(await getReportServiceOfferingId(999)).toBeNull();
    expect(await getReportedServiceOfferings([OFFERING])).toEqual([
      expect.objectContaining({
        id: OFFERING,
        title: 'Custom badge',
        description: 'One animated badge',
        status: 'Active',
        sellerUsername: 'badgesmith',
        removedReason: null,
      }),
    ]);
  });

  it('removes it with the reason, details and moderator, and tells the seller once', async () => {
    await pg.query(`UPDATE "ServiceOffering" SET "updatedAt" = '2026-01-01' WHERE id = $1`, [
      OFFERING,
    ]);
    const result = await takeDown();
    // As Prisma's @updatedAt does on the main app's write.
    const { rows } = await pg.query<{ updatedAt: Date }>(
      `SELECT "updatedAt" FROM "ServiceOffering" WHERE id = $1`,
      [OFFERING]
    );
    expect(rows[0].updatedAt.getTime()).toBeGreaterThan(new Date('2026-01-02').getTime());
    expect(result).toMatchObject({ changed: true, status: 'Removed', removedReason: 'misleading' });
    expect(await offering()).toEqual({
      status: 'Removed',
      removedReason: 'misleading',
      removedDetails: 'Links off-site',
      removedById: MOD,
    });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SELLER,
        type: 'service-offering-taken-down',
        key: `service-offering-taken-down:${OFFERING}`,
      })
    );
    expect(JSON.stringify(createNotification.mock.calls)).not.toContain(String(MOD));
    // The note stays on the row; only `other` sends its details to the seller.
    expect(JSON.stringify(createNotification.mock.calls)).not.toContain('Links off-site');
    expect(recordModActivity).toHaveBeenCalledTimes(1);
  });

  // Decision (briony, 2026-10-15): one takedown per offering, so a second neither rewrites the
  // record nor notifies the seller again.
  it('leaves an offering already taken down as it was, and sends nothing', async () => {
    await takeDown('misleading');
    vi.clearAllMocks();
    const second = await takeDown('spam', MOD + 1);
    expect(second).toMatchObject({ changed: false, removedReason: 'misleading' });
    expect(await offering()).toMatchObject({ removedReason: 'misleading', removedById: MOD });
    expect(createNotification).not.toHaveBeenCalled();
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  // Decision (briony, 2026-10-15): removing first does not dodge a takedown.
  it('takes down an offering its seller already removed', async () => {
    await pg.query(`UPDATE "ServiceOffering" SET status = 'Removed' WHERE id = $1`, [OFFERING]);
    const result = await takeDown();
    expect(result).toMatchObject({ changed: true, removedReason: 'misleading' });
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('is null for an offering that no longer exists', async () => {
    expect(
      await takedownServiceOffering({
        offeringId: 999,
        reason: 'spam',
        details: null,
        moderatorId: MOD,
      })
    ).toBeNull();
    expect(createNotification).not.toHaveBeenCalled();
  });
});
