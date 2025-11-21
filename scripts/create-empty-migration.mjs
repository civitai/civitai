import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

// Get migration name from command line args
const migrationName = process.argv[2];

if (!migrationName) {
  console.error('Error: Migration name is required');
  console.error('Usage: npm run db:migrate:empty <migration-name>');
  process.exit(1);
}

// Convert migration name to snake_case
const toSnakeCase = (str) => {
  return str
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2') // Handle camelCase
    .replace(/[\s-]+/g, '_') // Replace spaces and hyphens with underscores
    .replace(/[^\w]+/g, '') // Remove non-word characters
    .toLowerCase();
};

// Generate timestamp in format: YYYYMMDDHHMMSS
const getTimestamp = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
};

const timestamp = getTimestamp();
const snakeCaseName = toSnakeCase(migrationName);
const folderName = `${timestamp}_${snakeCaseName}`;
const migrationPath = join('prisma', 'migrations', folderName);

try {
  // Create migration folder
  await mkdir(migrationPath, { recursive: true });

  // Create empty migration.sql file
  await writeFile(join(migrationPath, 'migration.sql'), '-- Add migration here\n');

  console.log(`✓ Created empty migration: ${folderName}`);
  console.log(`  Location: ${migrationPath}/migration.sql`);
} catch (error) {
  console.error('Error creating migration:', error.message);
  process.exit(1);
}
