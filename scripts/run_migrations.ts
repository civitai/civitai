import fs from 'fs/promises';
import * as process from 'node:process';
import { pgDbWrite } from '~/server/db/pgDb';
import { insertNewMigrations } from './gen_seed';

const baseDir = './prisma/migrations';

async function main() {
  const alreadyRunQuery = await pgDbWrite.query<{ migration_name: string }>(
    `SELECT migration_name FROM "_prisma_migrations" where finished_at is not null`
  );
  const alreadyRun = alreadyRunQuery.rows.map((r) => r.migration_name);

  const folders = await fs.readdir(baseDir, { withFileTypes: true });
  const newMigrations: string[] = [];
  const failedMigrations: string[] = [];

  for (const folder of folders) {
    if (folder.isDirectory()) {
      try {
        if (!alreadyRun.includes(folder.name)) {
          const content = await fs.readFile(`${baseDir}/${folder.name}/migration.sql`, 'utf-8');
          console.log(`Applying ${folder.name}...`);
          await pgDbWrite.query(content);
          newMigrations.push(folder.name);
        }
      } catch (err) {
        console.error(err);
        failedMigrations.push(folder.name);
      }
    }
  }

  if (newMigrations.length > 0) {
    await insertNewMigrations(newMigrations);
  }

  if (newMigrations.length || failedMigrations.length) {
    console.log('--------------------');
    console.log(`Finished migrations.`);
    console.log(`Successes: ${newMigrations.length}.`);
    console.log(`Failures: ${failedMigrations.length}.`);
  } else {
    console.log('Up to date.');
  }
}

main().then(() => {
  process.exit(0);
});
