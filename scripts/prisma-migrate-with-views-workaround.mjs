const SCHEMA = 'prisma/schema.prisma';
const BACKUP = 'prisma/schema.prisma.backup';
const ANNOTATION = '/// @view';

import pkg from 'pg';
const { Client } = pkg;
import { promises as fs } from 'fs';
import { argv } from 'process';
import { spawnSync } from 'child_process';
import * as path from 'path';

import { config } from 'dotenv';
config();

const spawnOptions = { stdio: 'inherit', shell: true };

async function runSqlFilesFromDirectory(baseDir) {
  const sqlFilesPath = path.resolve(baseDir); // Ensure the path is absolute

  try {
    console.log('Extracting and executing view SQL from:', sqlFilesPath);
    const files = await fs.readdir(sqlFilesPath);
    const sqlFiles = files.filter(file => file.endsWith('.sql'));

    for (const file of sqlFiles) {
      const filePath = path.join(sqlFilesPath, file);
      console.log(`Executing SQL in file: ${filePath}`);
      const sql = await fs.readFile(filePath, 'utf-8');
      await executeSQL(sql);
    }

    console.log('All view SQL execution complete.');
  } catch (error) {
    console.error('Failed to execute SQL files:', error);
  }
}

// Function to check if the backup exists
async function fileExists(file) {
  try {
    await fs.stat(file);
    return true;  // Backup exists
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('Backup file does not exist:', BACKUP);
      return false;  // Backup does not exist
    }
    throw error;  // Rethrow other errors that aren't related to file non-existence
  }
}

// Function to execute SQL on PostgreSQL
async function executeSQL(sql) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  await client.connect();
  try {
    await client.query(sql);
  } catch (err) {
    console.error('Error executing SQL:', err);
  } finally {
    await client.end();
  }
}

// Backup the schema
await fs.copyFile(SCHEMA, BACKUP);
console.log('Backed up schema to', BACKUP);

// Remove all views
console.log('Removing views from schema...');
const schema = await fs.readFile(SCHEMA, 'utf-8');
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
await fs.writeFile(SCHEMA, modifiedSchema, 'utf-8');
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
  await fs.unlink(SCHEMA);
  await fs.rename(BACKUP, SCHEMA);
  ({ error } = spawnSync('prisma generate', spawnOptions));
  if (error) throw error;
  console.log('Restoring backup and running `npx prisma generate`... Done');
  console.log('Loading views...');
  runSqlFilesFromDirectory("./sql/views");


} catch (error) {
  // Restore the schema
  if (await fileExists(BACKUP)) {
    console.log('Restoring backup... ');
    await fs.unlink(SCHEMA);
    await fs.rename(BACKUP, SCHEMA);
    console.log('Restoring backup... Done');
  }

  // Rethrow the error
  throw error;
}
