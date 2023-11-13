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
  const modelRegex = new RegExp(`^.+${modelName}(\\[\\]|\\n|\\?).*\n?`, 'gm');
  modifiedSchema = modifiedSchema.replace(modelRegex, '');
}

// If no check, change DB to dark-pit
const noCheckFlagIndex = argv.indexOf('--no-check');
const noCheck = noCheckFlagIndex > -1;
if (noCheck) {
  argv.splice(noCheckFlagIndex, 1);
  modifiedSchema = modifiedSchema.replace('SHADOW_DATABASE_URL', 'DARKPIT_SHADOW_URL');
  modifiedSchema = modifiedSchema.replace('DATABASE_URL', 'DARKPIT_URL');
}

// Write the modified schema
await writeFile(SCHEMA, modifiedSchema, 'utf-8');
console.log('Removing views from schema... Done');

try {
  // Run the migration
  console.log('Running `prisma migrate dev`... ');
  const productionFlagIndex = argv.indexOf('-p');
  const runProduction = productionFlagIndex > -1;
  if (runProduction) argv.splice(productionFlagIndex, 1);
  else argv.push('--create-only');

  let { error } = spawnSync(
    `prisma migrate ${runProduction ? 'deploy' : 'dev'}`,
    !runProduction ? argv.slice(2) : [],
    spawnOptions
  );
  if (error) throw error;
  console.log('Running `prisma migrate dev`... Done');

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
