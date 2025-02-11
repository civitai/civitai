import { Prisma } from '@prisma/client';
import { ToolType } from '~/shared/utils/prisma/enums';
import { TOOLS_SEARCH_INDEX } from '~/server/common/constants';
import { updateDocs } from '~/server/meilisearch/client';

import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';

import { isDefined } from '~/utils/type-guards';

const READ_BATCH_SIZE = 1000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = TOOLS_SEARCH_INDEX;

const searchableAttributes = ['name', 'domain', 'company', 'description'];
const sortableAttributes = ['createdAt', 'name'];
const filterableAttributes = ['id', 'type', 'company'];
const rankingRules = [
  'supported:desc',
  'sort',
  'words',
  'typo',
  'proximity',
  'attribute',
  'exactness',
];

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  if (!index) return;

  console.log('onIndexSetup :: Index has been gotten or created', index);
  const settings = await index.getSettings();

  if (JSON.stringify(searchableAttributes) !== JSON.stringify(settings.searchableAttributes)) {
    const updateSearchableAttributesTask = await index.updateSearchableAttributes(
      searchableAttributes
    );
    console.log(
      'onIndexSetup :: updateSearchableAttributesTask created',
      updateSearchableAttributesTask
    );
  }

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);
    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  }

  if (
    JSON.stringify(filterableAttributes.sort()) !== JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      filterableAttributes
    );

    console.log(
      'onIndexSetup :: updateFilterableAttributesTask created',
      updateFilterableAttributesTask
    );
  }

  console.log('onIndexSetup :: all tasks completed');
};

type BaseTool = {
  id: number;
  name: string;
  icon: string | null;
  createdAt: Date;
  type: ToolType;
  supported: boolean;
  domain: string | null;
  description: string | null;
  homepage: string | null;
  company: string | null;
  bannerUrl: string | null;
  alias: string | null;
};

const WHERE = [Prisma.sql`t.enabled = TRUE AND t.unlisted = FALSE`];

const transformData = async ({ tools }: { tools: BaseTool[] }) => {
  return tools; // No transformation needed
};

export type ToolSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

export const toolsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  setup: onIndexSetup,
  prepareBatches: async ({ db, logger }, lastUpdatedAt) => {
    const where = [
      ...WHERE,
      lastUpdatedAt ? Prisma.sql`t."createdAt" >= ${lastUpdatedAt}` : undefined,
    ].filter(isDefined);

    const data = await db.$queryRaw<{ startId: number; endId: number }[]>`
      SELECT MIN(id) as "startId", MAX(id) as "endId" FROM "Tool" t
      WHERE ${Prisma.join(where, ' AND ')}
    `;

    const { startId, endId } = data[0];

    logger(
      `PrepareBatches :: Prepared batch: ${startId} - ${endId} ... Last updated: ${lastUpdatedAt}`
    );

    return {
      batchSize: READ_BATCH_SIZE,
      startId,
      endId,
    };
  },
  pullData: async ({ db, logger }, batch) => {
    logger(
      `PullData :: Pulling data for batch`,
      batch.type === 'new' ? `${batch.startId} - ${batch.endId}` : batch.ids.length
    );
    const where = [
      ...WHERE,
      batch.type === 'update' ? Prisma.sql`t.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`t.id >= ${batch.startId} AND t.id <= ${batch.endId}`
        : undefined,
    ].filter(isDefined);

    const tools = await db.$queryRaw<BaseTool[]>`
      SELECT
        t.id,
        t.name,
        t."createdAt",
        t.icon,
        t.type,
        t.supported,
        t.domain,
        t.description,
        t.homepage,
        t.company,
        t.alias,
        t.metadata ->> 'header' as "bannerUrl"
      FROM "Tool" t
      WHERE ${Prisma.join(where, ' AND ')}
    `;
    if (!tools.length) return null;

    return { tools };
  },
  transformData,
  pushData: async ({ indexName }, records) => {
    await updateDocs({
      indexName,
      documents: records,
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });

    return;
  },
});
