import { MeiliSearch } from 'meilisearch';
import { updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { limitConcurrency, sleep, Task } from '~/server/utils/concurrency-helpers';
import { withRetries } from '~/utils/errorHandling';

async function main() {
  try {
    const sourceUrl = process.argv[2];
    const sourceApiKey = process.argv[3];
    const targetUrl = process.argv[4];
    const targetApiKey = process.argv[5];
    const indexesToMigrate = process.argv[6] ? process.argv[6].split(',') : [];
    const baseCursor = process.argv[7]
      ? process.argv[7].split(',').map((n) => Number.parseInt(n))
      : 0;

    if (!sourceUrl || !sourceApiKey || !targetUrl || !targetApiKey) {
      throw new Error('Missing arguments');
    }

    const source = new MeiliSearch({
      host: sourceUrl,
      apiKey: sourceApiKey,
    });
    const target = new MeiliSearch({
      host: targetUrl,
      apiKey: targetApiKey,
    });

    const indexes = indexesToMigrate.length
      ? indexesToMigrate
      : (await source.getIndexes()).results.map((index) => index.uid);

    const highestIds: Record<string, number> = {};

    console.log('Indexes to migrate :: ', indexes);

    const jobs = indexes.map((index, i) => async () => {
      try {
        const sourceIndex = await getOrCreateIndex(index, { primaryKey: 'id' }, source);
        const targetIndex = await getOrCreateIndex(index, { primaryKey: 'id' }, target);

        if (!sourceIndex || !targetIndex) {
          throw new Error('Could not create indexes');
        }

        // Clone settings:
        const settings = await sourceIndex.getSettings();
        const targetSettings = await targetIndex.getSettings();

        if (
          !settings.sortableAttributes?.includes('id') ||
          !settings.filterableAttributes?.includes('id')
        ) {
          throw new Error(
            'Index must be sortable and filterable by ID. Please update the settings in the index'
          );
        }

        if (JSON.stringify(settings) !== JSON.stringify(targetSettings)) {
          await target.index(index).updateSettings(settings);
        }

        // Now, we can go ahead and start adding stuff:
        let cursor = Array.isArray(baseCursor) ? baseCursor[i] : baseCursor;
        const batchSize = Math.min(settings.pagination?.maxTotalHits ?? 1000000, 100000);
        let endCursor = cursor + batchSize;

        const { hits } = await source.index(index).search('', {
          offset: 0,
          limit: 1,
          sort: ['id:desc'],
        });

        if (hits.length === 0) {
          return;
        }

        // Play it safe:
        endCursor = Math.max(hits[0].id + 1, endCursor);

        console.log('Highest ID registered :: ', endCursor, ' Starting from:', cursor);

        highestIds[index] = endCursor;

        const tasks: Task[] = [];
        while (cursor < endCursor) {
          const start = cursor;
          let end = start + batchSize;
          if (end > endCursor) end = endCursor + 1;
          tasks.push(async () => {
            try {
              return withRetries(
                async (remainingAttempts) => {
                  try {
                    console.log('Getting documents :: ', { start, end });
                    const { hits } = await source.index(index).search('', {
                      offset: 0,
                      limit: batchSize + 1,
                      filter: `id >= ${start} AND id < ${end}`,
                      sort: ['id:asc'],
                    });

                    if (hits.length === 0) {
                      return;
                    }

                    console.log('Updating documents :: ', hits.length, { start, end });

                    await updateDocs({
                      indexName: index,
                      documents: hits,
                      client: target,
                      batchSize: 10000,
                    });

                    console.log('Updated documents :: ', { start, end });

                    // Ensure we try to avoid rate limiting.
                    await sleep((5 - remainingAttempts) * 1000);
                  } catch (e) {
                    console.error('Error updating documents :: ', e, {
                      start,
                      end,
                      remainingAttempts,
                    });

                    throw e;
                  }
                },
                5,
                5000
              );
            } catch (e) {
              // No-op. Batch just failde.
              console.error('Error updating batch :: ', e);
            }
          });

          cursor = end;
        }

        console.log('Total number of tasks: ', tasks.length);

        await limitConcurrency(tasks, 10);

        console.log('Index migration completed :: ', index);
      } catch (e) {
        console.error('Error migrating index :: ', index, e);
      }
    });

    // Migrate 1 by 1.
    await limitConcurrency(jobs, 1);

    console.log('Migration completed', {
      ...highestIds,
      updateQuery: `npm run meilisearch:migrate ${sourceUrl} ${sourceApiKey} ${targetUrl} ${targetApiKey} ${Object.keys(
        highestIds
      ).join(',')} ${Object.keys(highestIds)
        .map((key) => highestIds[key])
        .join(',')}`,
    });

    process.exit(0);
  } catch (e) {
    console.error('Error :: ', e);
    process.exit(-1);
  }
}

main();
