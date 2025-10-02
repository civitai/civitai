import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createProfanityFilter } from '~/libs/profanity-simple';
import {
  MODELS_SEARCH_INDEX,
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
} from '~/server/common/constants';
import { articlesSearchIndex, bountiesSearchIndex, modelsSearchIndex } from '~/server/search-index';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { booleanString } from '~/utils/zod-helpers';
import type { ArticleMetadata } from '~/server/schema/article.schema';
import type { ModelMeta } from '~/server/schema/model.schema';
import type { BountyDetailsSchema } from '~/server/schema/bounty.schema';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(15),
  batchSize: z.coerce.number().min(10).optional().default(500),
  start: z.coerce.number().optional().default(0),
  end: z.coerce.number().optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  entity: z.enum(['models', 'articles', 'bounties']),
  dryRun: booleanString().default(true),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('PROFANITY_MIGRATION_TIMER');
  await migrateProfanityNsfw(req, res);
  console.timeEnd('PROFANITY_MIGRATION_TIMER');
  res.status(200).json({ finished: true });
});

async function migrateProfanityNsfw(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  const { entity, dryRun } = params;

  // Initialize profanity filter
  const profanityFilter = createProfanityFilter();

  const entityConfig = {
    models: {
      tableName: 'Model',
      searchIndex: MODELS_SEARCH_INDEX,
      textFields: ['name', 'description'],
      rangeFetcher: async () => {
        if (params.after) {
          const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
            WITH dates AS (
              SELECT
              MIN("createdAt") as start,
              MAX("createdAt") as end
              FROM "Model" WHERE "createdAt" > ${params.after}
            )
            SELECT MIN(id) as start, MAX(id) as end
            FROM "Model" m
            JOIN dates d ON d.start = m."createdAt" OR d.end = m."createdAt";
          `;
          return results[0];
        }
        const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
          Prisma.sql`SELECT MAX(id) "max" FROM "Model";`
        );
        return { start: params.start, end: max };
      },
      processor: async ({
        start,
        end,
        cancelFns,
      }: {
        start: number;
        end: number;
        cancelFns: (() => void)[];
      }) => {
        // Fetch records to check
        const records = await dbRead.$queryRaw<
          {
            id: number;
            name: string;
            description: string | null;
            nsfw: boolean;
            lockedProperties: string[];
            meta: ModelMeta;
          }[]
        >`
          SELECT id, name, description, nsfw, "lockedProperties", meta
          FROM "Model"
          WHERE id BETWEEN ${start} AND ${end}
        `;

        const updatesToMake: {
          id: number;
          nsfw: boolean;
          lockedProperties: string[];
          meta: ModelMeta;
        }[] = [];
        const searchIndexUpdates: { id: number }[] = [];

        for (const record of records) {
          const textToCheck = [record.name, record.description].filter(Boolean).join(' ');
          const { isProfane, matchedWords } = profanityFilter.analyze(textToCheck);

          if (isProfane && !record.nsfw) {
            const newLockedProperties =
              record.lockedProperties && !record.lockedProperties.includes('nsfw')
                ? [...record.lockedProperties, 'nsfw']
                : ['nsfw'];

            const updatedMeta = {
              ...(record.meta || {}),
              profanityMatches: matchedWords,
            };

            updatesToMake.push({
              id: record.id,
              nsfw: true,
              lockedProperties: newLockedProperties,
              meta: updatedMeta,
            });
            searchIndexUpdates.push({ id: record.id });
          }
        }

        if (updatesToMake.length > 0) {
          if (dryRun) {
            console.log(
              `[DRY RUN] Would update ${updatesToMake.length} models (${start} - ${end}):`
            );
            console.dir(
              { result: updatesToMake.map((u) => ({ id: u.id, nsfw: u.nsfw, meta: u.meta })) },
              { depth: null }
            );
          } else {
            // Update database using parameterized bulk update
            // We use VALUES with parameterized queries to safely update multiple records at once
            // Each record needs 4 parameters: id, nsfw, lockedProperties, meta
            // The map creates placeholders: ($1,$2,$3,$4), ($5,$6,$7,$8), etc.
            // i * 4 ensures each record gets the next 4 parameter slots
            const { cancel, result } = await pgDbWrite.cancellableQuery(
              `
                UPDATE "Model"
                SET nsfw = data.nsfw::boolean, "lockedProperties" = data."lockedProperties"::text[], meta = data.meta::jsonb
                FROM (VALUES ${updatesToMake
                  .map(
                    (_, i) =>
                      `($${i * 4 + 1}::integer, $${i * 4 + 2}::boolean, $${i * 4 + 3}::text, $${
                        i * 4 + 4
                      }::jsonb)`
                  )
                  .join(', ')}) AS data(id, nsfw, "lockedProperties", meta)
                WHERE "Model".id = data.id
              `,
              // flatMap creates the parameter array in the same order as the placeholders
              // For 2 records: [id1, nsfw1, props1, meta1, id2, nsfw2, props2, meta2]
              updatesToMake.flatMap((u) => [
                u.id,
                u.nsfw,
                `{${u.lockedProperties.map((p) => `"${p}"`).join(',')}}`,
                JSON.stringify(u.meta),
              ])
            );

            cancelFns.push(cancel);
            await result();

            // Update search index
            if (searchIndexUpdates.length > 0) {
              modelsSearchIndex.queueUpdate(
                searchIndexUpdates.map(({ id }) => ({
                  id,
                  action: SearchIndexUpdateQueueAction.Update,
                }))
              );
            }

            console.log(`Updated ${updatesToMake.length} models (${start} - ${end})`);
          }
        } else {
          console.log(`No profane models found (${start} - ${end})`);
        }
      },
    },
    articles: {
      tableName: 'Article',
      searchIndex: ARTICLES_SEARCH_INDEX,
      textFields: ['title', 'content'],
      rangeFetcher: async () => {
        if (params.after) {
          const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
            WITH dates AS (
              SELECT
              MIN("createdAt") as start,
              MAX("createdAt") as end
              FROM "Article" WHERE "createdAt" > ${params.after}
            )
            SELECT MIN(id) as start, MAX(id) as end
            FROM "Article" a
            JOIN dates d ON d.start = a."createdAt" OR d.end = a."createdAt";
          `;
          return results[0];
        }
        const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
          Prisma.sql`SELECT MAX(id) "max" FROM "Article";`
        );
        return { start: params.start, end: max };
      },
      processor: async ({
        start,
        end,
        cancelFns,
      }: {
        start: number;
        end: number;
        cancelFns: (() => void)[];
      }) => {
        const records = await dbRead.$queryRaw<
          {
            id: number;
            title: string;
            content: string | null;
            nsfw: boolean;
            userNsfwLevel: number;
            lockedProperties: string[];
            metadata: ArticleMetadata;
          }[]
        >`
          SELECT id, title, content, nsfw, "userNsfwLevel", "lockedProperties", metadata
          FROM "Article"
          WHERE id BETWEEN ${start} AND ${end}
        `;

        const updatesToMake: {
          id: number;
          nsfw: boolean;
          userNsfwLevel: number;
          lockedProperties: string[];
          metadata: ArticleMetadata;
        }[] = [];
        const searchIndexUpdates: { id: number }[] = [];

        for (const record of records) {
          const textToCheck = [record.title, record.content].filter(Boolean).join(' ');
          const { isProfane, matchedWords } = profanityFilter.analyze(textToCheck);

          if (isProfane && (record.userNsfwLevel <= NsfwLevel.PG13 || !record.nsfw)) {
            const newLockedProperties = [
              ...(record.lockedProperties || []),
              'nsfw',
              'userNsfwLevel',
            ];

            const updatedMetadata = {
              ...(record.metadata || {}),
              profanityMatches: matchedWords,
            };

            updatesToMake.push({
              id: record.id,
              nsfw: true,
              userNsfwLevel: NsfwLevel.R,
              lockedProperties: newLockedProperties,
              metadata: updatedMetadata,
            });
            searchIndexUpdates.push({ id: record.id });
          }
        }

        if (updatesToMake.length > 0) {
          if (dryRun) {
            console.log(
              `[DRY RUN] Would update ${updatesToMake.length} articles (${start} - ${end}):`
            );
            console.dir(
              {
                result: updatesToMake.map((u) => ({
                  id: u.id,
                  nsfw: u.nsfw,
                  userNsfwLevel: u.userNsfwLevel,
                  metadata: u.metadata,
                })),
              },
              { depth: null }
            );
          } else {
            // Update database using parameterized bulk update
            // Articles need 5 parameters per record: id, nsfw, userNsfwLevel, lockedProperties, metadata
            // i * 5 ensures each record gets the next 5 parameter slots: ($1,$2,$3,$4,$5), ($6,$7,$8,$9,$10), etc.
            const { cancel, result } = await pgDbWrite.cancellableQuery(
              `
                UPDATE "Article"
                SET nsfw = data.nsfw::boolean, "userNsfwLevel" = data."userNsfwLevel"::integer, "lockedProperties" = data."lockedProperties"::text[], metadata = data.metadata::jsonb
                FROM (VALUES ${updatesToMake
                  .map(
                    (_, i) =>
                      `($${i * 5 + 1}::integer, $${i * 5 + 2}::boolean, $${i * 5 + 3}::integer, $${
                        i * 5 + 4
                      }::text, $${i * 5 + 5}::jsonb)`
                  )
                  .join(', ')}) AS data(id, nsfw, "userNsfwLevel", "lockedProperties", metadata)
                WHERE "Article".id = data.id
              `,
              // Parameter array matches the placeholder order
              updatesToMake.flatMap((u) => [
                u.id,
                u.nsfw,
                u.userNsfwLevel,
                `{${u.lockedProperties.map((p) => `"${p}"`).join(',')}}`,
                JSON.stringify(u.metadata),
              ])
            );

            cancelFns.push(cancel);
            await result();

            if (searchIndexUpdates.length > 0) {
              articlesSearchIndex.queueUpdate(
                searchIndexUpdates.map(({ id }) => ({
                  id,
                  action: SearchIndexUpdateQueueAction.Update,
                }))
              );
            }

            console.log(`Updated ${updatesToMake.length} articles (${start} - ${end})`);
          }
        } else {
          console.log(`No profane articles found (${start} - ${end})`);
        }
      },
    },
    bounties: {
      tableName: 'Bounty',
      searchIndex: BOUNTIES_SEARCH_INDEX,
      textFields: ['name', 'description'],
      rangeFetcher: async () => {
        if (params.after) {
          const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
            WITH dates AS (
              SELECT
              MIN("createdAt") as start,
              MAX("createdAt") as end
              FROM "Bounty" WHERE "createdAt" > ${params.after}
            )
            SELECT MIN(id) as start, MAX(id) as end
            FROM "Bounty" b
            JOIN dates d ON d.start = b."createdAt" OR d.end = b."createdAt";
          `;
          return results[0];
        }
        const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
          Prisma.sql`SELECT MAX(id) "max" FROM "Bounty";`
        );
        return { start: params.start, end: max };
      },
      processor: async ({
        start,
        end,
        cancelFns,
      }: {
        start: number;
        end: number;
        cancelFns: (() => void)[];
      }) => {
        const records = await dbRead.$queryRaw<
          {
            id: number;
            name: string;
            description: string | null;
            nsfw: boolean;
            lockedProperties: string[];
            details: BountyDetailsSchema;
          }[]
        >`
          SELECT id, name, description, nsfw, "lockedProperties", details
          FROM "Bounty"
          WHERE id BETWEEN ${start} AND ${end}
        `;

        const updatesToMake: {
          id: number;
          nsfw: boolean;
          lockedProperties: string[];
          details: BountyDetailsSchema;
        }[] = [];
        const searchIndexUpdates: { id: number; nsfw: boolean }[] = [];

        for (const record of records) {
          const textToCheck = [record.name, record.description].filter(Boolean).join(' ');
          const { isProfane, matchedWords } = profanityFilter.analyze(textToCheck);

          if (isProfane && !record.nsfw) {
            const newLockedProperties =
              record.lockedProperties && !record.lockedProperties.includes('nsfw')
                ? [...record.lockedProperties, 'nsfw']
                : ['nsfw'];

            const updatedDetails = {
              ...(record.details || {}),
              profanityMatches: matchedWords,
            };

            updatesToMake.push({
              id: record.id,
              nsfw: true,
              lockedProperties: newLockedProperties,
              details: updatedDetails,
            });
            searchIndexUpdates.push({ id: record.id, nsfw: true });
          }
        }

        if (updatesToMake.length > 0) {
          if (dryRun) {
            console.log(
              `[DRY RUN] Would update ${updatesToMake.length} bounties (${start} - ${end}):`
            );
            console.dir(
              {
                result: updatesToMake.map((u) => ({ id: u.id, nsfw: u.nsfw, details: u.details })),
              },
              { depth: null }
            );
          } else {
            // Update database using parameterized bulk update
            // Bounties need 4 parameters per record: id, nsfw, lockedProperties, details
            // i * 4 ensures each record gets the next 4 parameter slots: ($1,$2,$3,$4), ($5,$6,$7,$8), etc.
            const { cancel, result } = await pgDbWrite.cancellableQuery(
              `
                UPDATE "Bounty"
                SET nsfw = data.nsfw::boolean, "lockedProperties" = data."lockedProperties"::text[], details = data.details::jsonb
                FROM (VALUES ${updatesToMake
                  .map(
                    (_, i) =>
                      `($${i * 4 + 1}::integer, $${i * 4 + 2}::boolean, $${i * 4 + 3}::text, $${
                        i * 4 + 4
                      }::jsonb)`
                  )
                  .join(', ')}) AS data(id, nsfw, "lockedProperties", details)
                WHERE "Bounty".id = data.id
              `,
              // Parameter array matches the placeholder order
              updatesToMake.flatMap((u) => [
                u.id,
                u.nsfw,
                `{${u.lockedProperties.map((p) => `"${p}"`).join(',')}}`,
                JSON.stringify(u.details),
              ])
            );

            cancelFns.push(cancel);
            await result();

            if (searchIndexUpdates.length > 0) {
              bountiesSearchIndex.queueUpdate(
                searchIndexUpdates.map(({ id }) => ({
                  id,
                  action: SearchIndexUpdateQueueAction.Update,
                }))
              );
            }

            console.log(`Updated ${updatesToMake.length} bounties (${start} - ${end})`);
          }
        } else {
          console.log(`No profane bounties found (${start} - ${end})`);
        }
      },
    },
  };

  const config = entityConfig[entity];

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: config.rangeFetcher,
    processor: config.processor,
  });
}
