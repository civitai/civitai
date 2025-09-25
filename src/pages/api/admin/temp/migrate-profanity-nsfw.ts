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

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(15),
  batchSize: z.coerce.number().min(0).optional().default(500),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  entity: z.enum(['models', 'articles', 'bounties']),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('PROFANITY_MIGRATION_TIMER');
  await migrateProfanityNsfw(req, res);
  console.timeEnd('PROFANITY_MIGRATION_TIMER');
  res.status(200).json({ finished: true });
});

async function migrateProfanityNsfw(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  const { entity } = params;

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
          }[]
        >`
          SELECT id, name, description, nsfw, "lockedProperties"
          FROM "Model"
          WHERE id BETWEEN ${start} AND ${end}
        `;

        const updatesToMake: { id: number; nsfw: boolean; lockedProperties: string[] }[] = [];
        const searchIndexUpdates: { id: number }[] = [];

        for (const record of records) {
          const textToCheck = [record.name, record.description].filter(Boolean).join(' ');
          const hasProfanity = profanityFilter.isProfane(textToCheck);

          if (hasProfanity && !record.nsfw) {
            const newLockedProperties =
              record.lockedProperties && !record.lockedProperties.includes('nsfw')
                ? [...record.lockedProperties, 'nsfw']
                : ['nsfw'];
            updatesToMake.push({
              id: record.id,
              nsfw: true,
              lockedProperties: newLockedProperties,
            });
            searchIndexUpdates.push({ id: record.id });
          }
        }

        if (updatesToMake.length > 0) {
          // Update database using parameterized bulk update
          // We use VALUES with parameterized queries to safely update multiple records at once
          // Each record needs 3 parameters: id, nsfw, lockedProperties
          // The map creates placeholders: ($1,$2,$3), ($4,$5,$6), etc.
          // i * 3 ensures each record gets the next 3 parameter slots
          const { cancel, result } = await pgDbWrite.cancellableQuery(
            `
              UPDATE "Model" 
              SET nsfw = data.nsfw::boolean, "lockedProperties" = data."lockedProperties"::text[]
              FROM (VALUES ${updatesToMake
                .map(
                  (_, i) => `($${i * 3 + 1}::integer, $${i * 3 + 2}::boolean, $${i * 3 + 3}::text)`
                )
                .join(', ')}) AS data(id, nsfw, "lockedProperties")
              WHERE "Model".id = data.id
            `,
            // flatMap creates the parameter array in the same order as the placeholders
            // For 2 records: [id1, nsfw1, props1, id2, nsfw2, props2]
            updatesToMake.flatMap((u) => [
              u.id,
              u.nsfw,
              `{${u.lockedProperties.map((p) => `"${p}"`).join(',')}}`,
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
          }[]
        >`
          SELECT id, title, content, nsfw, "userNsfwLevel", "lockedProperties"
          FROM "Article"
          WHERE id BETWEEN ${start} AND ${end}
        `;

        const updatesToMake: {
          id: number;
          nsfw: boolean;
          userNsfwLevel: number;
          lockedProperties: string[];
        }[] = [];
        const searchIndexUpdates: { id: number }[] = [];

        for (const record of records) {
          const textToCheck = [record.title, record.content].filter(Boolean).join(' ');
          const hasProfanity = profanityFilter.isProfane(textToCheck);

          if (hasProfanity && (record.userNsfwLevel <= NsfwLevel.PG13 || !record.nsfw)) {
            const newLockedProperties = [
              ...(record.lockedProperties || []),
              'nsfw',
              'userNsfwLevel',
            ];
            updatesToMake.push({
              id: record.id,
              nsfw: true,
              userNsfwLevel: NsfwLevel.R,
              lockedProperties: newLockedProperties,
            });
            searchIndexUpdates.push({ id: record.id });
          }
        }

        if (updatesToMake.length > 0) {
          // Update database using parameterized bulk update
          // Articles need 4 parameters per record: id, nsfw, userNsfwLevel, lockedProperties
          // i * 4 ensures each record gets the next 4 parameter slots: ($1,$2,$3,$4), ($5,$6,$7,$8), etc.
          const { cancel, result } = await pgDbWrite.cancellableQuery(
            `
              UPDATE "Article"
              SET nsfw = data.nsfw::boolean, "userNsfwLevel" = data."userNsfwLevel"::integer, "lockedProperties" = data."lockedProperties"::text[]
              FROM (VALUES ${updatesToMake
                .map(
                  (_, i) =>
                    `($${i * 4 + 1}::integer, $${i * 4 + 2}::boolean, $${i * 4 + 3}::integer, $${
                      i * 4 + 4
                    }::text)`
                )
                .join(', ')}) AS data(id, nsfw, "userNsfwLevel", "lockedProperties")
              WHERE "Article".id = data.id
            `,
            // Parameter array matches the placeholder order
            updatesToMake.flatMap((u) => [
              u.id,
              u.nsfw,
              u.userNsfwLevel,
              `{${u.lockedProperties.map((p) => `"${p}"`).join(',')}}`,
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
          }[]
        >`
          SELECT id, name, description, nsfw, "lockedProperties"
          FROM "Bounty"
          WHERE id BETWEEN ${start} AND ${end}
        `;

        const updatesToMake: { id: number; nsfw: boolean; lockedProperties: string[] }[] = [];
        const searchIndexUpdates: { id: number; nsfw: boolean }[] = [];

        for (const record of records) {
          const textToCheck = [record.name, record.description].filter(Boolean).join(' ');
          const hasProfanity = profanityFilter.isProfane(textToCheck);

          if (hasProfanity && !record.nsfw) {
            const newLockedProperties =
              record.lockedProperties && !record.lockedProperties.includes('nsfw')
                ? [...record.lockedProperties, 'nsfw']
                : ['nsfw'];
            updatesToMake.push({
              id: record.id,
              nsfw: true,
              lockedProperties: newLockedProperties,
            });
            searchIndexUpdates.push({ id: record.id, nsfw: true });
          }
        }

        if (updatesToMake.length > 0) {
          // Update database using parameterized bulk update
          // Bounties need 3 parameters per record: id, nsfw, lockedProperties
          // i * 3 ensures each record gets the next 3 parameter slots: ($1,$2,$3), ($4,$5,$6), etc.
          const { cancel, result } = await pgDbWrite.cancellableQuery(
            `
              UPDATE "Bounty"
              SET nsfw = data.nsfw::boolean, "lockedProperties" = data."lockedProperties"::text[]
              FROM (VALUES ${updatesToMake
                .map(
                  (_, i) => `($${i * 3 + 1}::integer, $${i * 3 + 2}::boolean, $${i * 3 + 3}::text)`
                )
                .join(', ')}) AS data(id, nsfw, "lockedProperties")
              WHERE "Bounty".id = data.id
            `,
            // Parameter array matches the placeholder order
            updatesToMake.flatMap((u) => [
              u.id,
              u.nsfw,
              `{${u.lockedProperties.map((p) => `"${p}"`).join(',')}}`,
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
