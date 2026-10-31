import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';

const migration = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_model_ownership/migration.sql'
);

export type OwnershipRow = {
  modelId: number;
  userId: number;
  reason: string;
  actorId: number | null;
};

/** A statement, or a step between statements such as the owner write a test's ORM mock stood in for. */
export type OwnershipStep =
  | { text: string; values: unknown[] }
  | ((db: PGlite) => Promise<unknown>);

/**
 * Runs `steps` against a Postgres stand-in holding `models` (`[id, userId]`) and the real
 * "ModelOwnership" migration, and returns the rows they recorded, in order.
 */
export async function recordedOwnership(
  models: [number, number][],
  steps: OwnershipStep[]
): Promise<OwnershipRow[]> {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);`);
    await db.exec(readFileSync(migration, 'utf8'));
    for (const [id, userId] of models)
      await db.query(`INSERT INTO "Model" (id, "userId") VALUES ($1, $2)`, [id, userId]);
    for (const step of steps) {
      if (typeof step === 'function') await step(db);
      else await db.query(step.text, step.values);
    }
    const { rows } = await db.query<OwnershipRow>(
      `SELECT "modelId", "userId", reason, "actorId" FROM "ModelOwnership" ORDER BY id`
    );
    return rows;
  } finally {
    await db.close();
  }
}
