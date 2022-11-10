const SCHEMA = 'prisma/schema.prisma';
const BACKUP = 'prisma/schema.prisma.backup';
const ANNOTATION = '/// @view';

import { readFile, writeFile, copyFile, rename, unlink } from 'fs/promises';
import { argv } from 'process';
import { spawnSync } from 'child_process';
const spawnOptions = { stdio: 'inherit', shell: true };

// Backup the schema
await copyFile(SCHEMA, BACKUP);
console.log('Backed up schema to', BACKUP);

// Remove all views
console.log('Removing views from schema...');
const schema = await readFile(SCHEMA, 'utf-8');
const viewRegex = new RegExp(`\n?${ANNOTATION}\nmodel ([a-zA-Z]+) {[^}]+}\n?`, 'g');
const modelNames = [...schema.matchAll(viewRegex)].map(([_, name]) => name);
let modifiedSchema = schema.replace(viewRegex, '');
for (const modelName of modelNames) {
  const modelRegex = new RegExp(`^.+${modelName}.*\n?`, 'gm');
  modifiedSchema = modifiedSchema.replace(modelRegex, '');
}
await writeFile(SCHEMA, modifiedSchema, 'utf-8');
console.log('Removing views from schema... Done');

try {
  // Run the migration
  console.log('Running `prisma migrate`... ');
  const productionFlagIndex = argv.indexOf('-p');
  let commandError = null;

  if (productionFlagIndex > -1) {
    const { error } = spawnSync('prisma migrate deploy', spawnOptions);
    commandError = error;
  } else {
    const nameFlagIndex = argv.indexOf('--name');
    const { error } = spawnSync(
      'prisma migrate dev',
      nameFlagIndex > -1 ? argv.slice(nameFlagIndex) : [],
      spawnOptions
    );
    commandError = error;
  }

  if (commandError) throw error;
  console.log('Running `prisma migrate`... Done');

  // Restore the schema
  console.log('Restoring backup and running `npx prisma generate`... ');
  await unlink(SCHEMA);
  await rename(BACKUP, SCHEMA);
  ({ error } = spawnSync('prisma generate', spawnOptions));
  if (error) throw error;
  console.log('Restoring backup and running `npx prisma generate`... Done');
} catch (error) {
  // Restore the schema
  console.log('Restoring backup... ');
  await unlink(SCHEMA);
  await rename(BACKUP, SCHEMA);
  console.log('Restoring backup... Done');

  // Rethrow the error
  throw error;
}
