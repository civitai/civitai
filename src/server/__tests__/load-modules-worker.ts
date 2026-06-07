import * as fs from 'fs';
import * as path from 'path';

const rootDir = path.resolve(__dirname, '../../..');

function getTsFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      if (file !== '__tests__' && file !== 'node_modules' && file !== '.git') {
        results = results.concat(getTsFiles(filePath));
      }
    } else if (
      (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) &&
      !filePath.endsWith('.d.ts') &&
      !filePath.endsWith('.test.ts') &&
      !filePath.endsWith('.spec.ts')
    ) {
      results.push(filePath);
    }
  }
  return results;
}

async function main() {
  const foldersToScan = [
    path.join(rootDir, 'src/server/routers'),
    path.join(rootDir, 'src/server/jobs'),
    path.join(rootDir, 'src/server/services'),
    path.join(rootDir, 'src/server/metrics'),
  ];

  let files: string[] = [];
  for (const folder of foldersToScan) {
    files = files.concat(getTsFiles(folder));
  }

  let failed = false;
  for (const file of files) {
    // Skip emerchantpay files because they intentionally validate and throw on missing 
    // EMERCHANTPAY_WPF_URL environment variables at module loading/initialization time.
    if (file.includes('emerchantpay')) continue;
    try {
      await import(file);
    } catch (err: any) {
      console.error(`❌ Failed to import ${path.relative(rootDir, file)}: ${err.message}\n${err.stack}`);
      failed = true;
    }
  }

  process.exit(failed ? 1 : 0);
}

main();
