import dayjs, { Dayjs } from 'dayjs';
import fs from 'fs/promises';
import * as process from 'node:process';
import { pgDbWrite } from '~/server/db/pgDb';
import { isDefined } from '~/utils/type-guards';

const baseDir = './prisma/migrations';
export const lastRunMigrationkey = 'last-run-migration';

async function main() {
  const lastRunQuery = await pgDbWrite.query<{ value: number | null }>(
    `SELECT value FROM "KeyValue" where key = '${lastRunMigrationkey}'`
  );
  const lastRun = lastRunQuery.rows[0]?.value;
  if (!isDefined(lastRun)) {
    console.error(`No value found for "${lastRunMigrationkey}" in KeyValue. Exiting.`);
    process.exit(1);
  }
  let lastRunDate: Dayjs;
  try {
    lastRunDate = dayjs(lastRun);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  console.log(`Last run: ${lastRunDate.toISOString()}`);

  // TODO it's possible to miss migrations if they are run, then a PR is merged in with a date older than that
  // TODO if one migration fails, it will not be run again
  // the option to fix both of these is to store the names in an array for "run_migrations"

  const currentDate = new Date().getTime();
  const folders = await fs.readdir(baseDir, { withFileTypes: true });
  let applied = false;

  for (const folder of folders) {
    if (folder.isDirectory() && folder.name !== '20241003192438_model_flag_poi_name_column') {
      try {
        const dateStr = folder.name.split('_')[0];
        const date = dayjs(dateStr);
        if (date.isAfter(lastRunDate)) {
          const content = await fs.readFile(`${baseDir}/${folder.name}/migration.sql`, 'utf-8');
          console.log(`Applying ${folder.name}...`);
          await pgDbWrite.query(content);
          applied = true;
        }
      } catch (err) {
        console.error(err);
      }
    }
  }

  if (applied) {
    console.log(`Finished migrations. Updating "${lastRunMigrationkey}".`);
    await pgDbWrite.query(
      `UPDATE "KeyValue" SET value='${currentDate}' WHERE key = '${lastRunMigrationkey}'`
    );
  } else {
    console.log('Up to date.');
  }
}

main().then(() => {
  process.exit(0);
});
