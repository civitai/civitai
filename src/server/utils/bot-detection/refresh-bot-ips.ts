// Pulls fresh CIDR snapshots from upstream and writes them next to verify-bot.ts.
// Run periodically (cron / GitHub Action) and review the diff in PR.
//
// Usage:
//   pnpm tsx src/server/utils/bot-detection/refresh-bot-ips.ts

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Source = { url: string; outFile: string };

const SOURCES: Source[] = [
  {
    url: 'https://developers.google.com/static/search/apis/ipranges/googlebot.json',
    outFile: 'googlebot-ips.json',
  },
  {
    url: 'https://developers.google.com/static/search/apis/ipranges/special-crawlers.json',
    outFile: 'google-special-ips.json',
  },
  {
    url: 'https://www.bing.com/toolbox/bingbot.json',
    outFile: 'bingbot-ips.json',
  },
];

type IpRangeJson = { prefixes: unknown[] };

function isIpRangeJson(value: unknown): value is IpRangeJson {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { prefixes?: unknown }).prefixes)
  );
}

async function refreshOne({ url, outFile }: Source): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status} ${res.statusText}`);
  const json: unknown = await res.json();
  if (!isIpRangeJson(json)) {
    throw new Error(`${url} returned unexpected shape (missing prefixes array)`);
  }
  const path = join(__dirname, outFile);
  await writeFile(path, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`✓ ${outFile} (${json.prefixes.length} prefixes)`);
}

async function main() {
  let failures = 0;
  for (const source of SOURCES) {
    try {
      await refreshOne(source);
    } catch (err) {
      failures++;
      console.error(`✗ ${source.outFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures > 0) {
    process.exit(1);
  }
}

main();
