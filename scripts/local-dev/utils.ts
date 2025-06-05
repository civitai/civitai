import { faker } from '@faker-js/faker';
import { capitalize } from 'lodash-es';
import process from 'node:process';
import format from 'pg-format';
import { getCleanedNSFWWords } from '~/components/Auction/auction.utils';
import { env } from '~/env/server';
import { pgDbWrite } from '~/server/db/pgDb';

const cleanWords = getCleanedNSFWWords();

export const checkLocalDb = () => {
  console.log(env.DATABASE_URL);
  if (!(env.DATABASE_URL.includes('localhost:15432') || env.DATABASE_URL.includes('db:5432'))) {
    console.error('ERROR: not running with local database server.');
    process.exit(1);
  }
};

export const checkLocalMeili = () => {
  if (
    !['http://localhost:7700', 'http://meilisearch:7700'].includes(env.METRICS_SEARCH_HOST ?? '') ||
    !['http://localhost:7700', 'http://meilisearch:7700'].includes(env.SEARCH_HOST ?? '')
  ) {
    console.error('ERROR: not running with local meilisearch server.');
    process.exit(1);
  }
};

const setSerial = async (table: string) => {
  // language=text
  const query = `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), coalesce(max(id)+1, 1), false) FROM %I`;

  try {
    await pgDbWrite.query(format(query, table));
    console.log(`\t-> ✔️ Set ID sequence`);
  } catch (error) {
    const e = error as MixedObject;
    console.log(`\t-> ❌  Error setting ID sequence`);
    console.log(`\t-> ${e.message}`);
    console.log(`\t-> Detail: ${e.detail}`);
    if (e.where) console.log(`\t-> where: ${e.where}`);
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const insertRows = async (table: string, data: any[][], hasId = true) => {
  if (!data.length) {
    console.log(`No rows to insert. Skipping ${table}.`);
    return [];
  }

  console.log(`Inserting ${data.length} rows into ${table}`);

  // language=text
  let query = 'INSERT INTO %I VALUES %L ON CONFLICT DO NOTHING';
  if (hasId) query += ' RETURNING ID';

  try {
    const ret = await pgDbWrite.query<{ id: number }>(format(query, table, data));

    if (ret.rowCount === data.length) console.log(`\t-> ✔️ Inserted ${ret.rowCount} rows`);
    else if (ret.rowCount === 0) console.log(`\t-> ⚠️ Inserted 0 rows`);
    else console.log(`\t-> ⚠️ Only inserted ${ret.rowCount} of ${data.length} rows`);

    if (hasId) {
      await setSerial(table);
    }

    return ret.rows.map((r) => r.id);
  } catch (error) {
    const e = error as MixedObject;
    console.log(`\t-> ❌  ${e.message}`);
    console.log(`\t-> Detail: ${e.detail}`);
    if (e.where) console.log(`\t-> where: ${e.where}`);
    return [];
  }
};

export const generateRandomName = (count: number) => {
  const randomNames = [];

  for (let i = 0; i < count; i++) {
    const adjective = capitalize(faker.word.adjective());
    const noun = faker.helpers.weightedArrayElement([
      { value: capitalize(faker.word.noun()), weight: 5 },
      { value: capitalize(faker.helpers.arrayElement(cleanWords)), weight: 1 },
    ]);

    randomNames.push(`${adjective} ${noun}`);
  }

  return randomNames.join(' ');
};
