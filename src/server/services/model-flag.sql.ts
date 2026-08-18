import { Prisma } from '@prisma/client';
import { ModelFlagStatus } from '~/shared/utils/prisma/enums';

/**
 * The `ModelFlag` upsert statement, isolated from `model-flag.service`.
 *
 * WHY ITS OWN MODULE: so a test can build and execute this statement without
 * importing the service, which pulls in the Prisma client, Axiom logging and
 * the search index at module scope. Extracting the helper is the repo's
 * preferred fix over widening a module mock.
 *
 * WHY IT IS TESTED AT ALL: this statement shipped broken for 15.5 months with
 * three separate punctuation defects, each masking the next, and no test in
 * the suite ever noticed — a raw SQL string is opaque to every mock, so
 * nothing parsed it. See `__tests__/model-flag-upsert-sql.test.ts`.
 */

export type ModelFlagScanResult = {
  poi: boolean;
  nsfw: boolean;
  minor: boolean;
  triggerWords: boolean;
  poiName: boolean;
  sfwOnly?: boolean;
};

export type ModelFlagRow = {
  modelId: number;
  poi: boolean;
  nsfw: boolean;
  minor: boolean;
  sfwOnly: boolean;
  triggerWords: boolean;
  // `ModelFlag."poiName"` is a NOT NULL boolean column, not a name string.
  // `$queryRaw`'s generic is an unchecked cast, so the previous
  // `string | null` was silently lying to callers about the row shape.
  poiName: boolean;
  status: ModelFlagStatus;
  // `RETURNING *` returns these too; naming them keeps the type an honest
  // description of the row rather than a partial one. `details` matches the
  // canonical `ModelFlag` interface rather than widening to `unknown`.
  details: Prisma.JsonValue | null;
  createdAt: Date;
};

/**
 * `details` absent must write a real SQL `NULL`.
 *
 * `Prisma.JsonNull` is a *value* sentinel for the Prisma query engine's typed
 * JSON inputs; interpolated into a `$queryRaw` template it is serialized as a
 * bound parameter and lands as the JSON object `{}`, not `NULL`. `Prisma.sql`
 * emits the literal into the statement instead.
 */
export function buildModelFlagUpsert({
  modelId,
  scanResult,
  details,
}: {
  modelId: number;
  scanResult?: ModelFlagScanResult;
  details?: MixedObject;
}): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "ModelFlag" ("modelId", "poi", "nsfw", "minor", "triggerWords", "poiName", "status", "details", "sfwOnly")
    VALUES (
      ${modelId},
      ${scanResult?.poi ?? false},
      ${scanResult?.nsfw ?? false},
      ${scanResult?.minor ?? false},
      ${scanResult?.triggerWords ?? false},
      ${scanResult?.poiName ?? false},
      ${Prisma.sql`${ModelFlagStatus.Pending}::"ModelFlagStatus"`},
      ${details ? Prisma.sql`${JSON.stringify(details)}::jsonb` : Prisma.sql`NULL`},
      ${scanResult?.sfwOnly ?? false}
    )
    ON CONFLICT ("modelId") DO UPDATE
      SET "poi" = EXCLUDED."poi",
        "nsfw" = EXCLUDED."nsfw",
        "minor" = EXCLUDED."minor",
        "triggerWords" = EXCLUDED."triggerWords",
        "poiName" = EXCLUDED."poiName",
        "status" = EXCLUDED."status",
        "details" = EXCLUDED."details",
        "sfwOnly" = EXCLUDED."sfwOnly"
    RETURNING *;
  `;
}
