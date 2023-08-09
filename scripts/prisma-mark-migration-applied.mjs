import { readdir } from 'fs/promises';
import { spawnSync } from 'child_process';
const spawnOptions = { stdio: 'inherit', shell: true };

// Get the last migration folder in the /migrations directory
const migrations = await readdir('prisma/migrations', { withFileTypes: true });
const lastMigration = migrations.filter((dirent) => dirent.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))[0].name;

console.log(`Marking migration "${lastMigration}" as applied...`);
try {
  const { error } = spawnSync(`prisma migrate resolve --applied "${lastMigration}"`, spawnOptions);
  if (error) throw error;
} catch (error) {
  // Restore the schema
  console.log('Failed...');
  // Rethrow the error
  throw error;
}
