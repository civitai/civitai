/**
 * Copy the live Stripe catalogue (products, prices, lookup keys, metadata) into the sandbox
 * that local dev uses. Live is read-only: the source key only ever reaches `createReader`.
 *
 *   pnpm exec tsx scripts/stripe-sandbox/sync.ts                 # dry run: prints the plan
 *   pnpm exec tsx scripts/stripe-sandbox/sync.ts --apply         # writes to the sandbox
 *     [--include-inactive] [--map-out <file.json>]
 *     [--dev-db]   with --apply: also upsert the sandbox Product/Price rows into DATABASE_URL
 *
 * Target: STRIPE_SECRET_KEY (process env, then the repo .env); must be sk_test_/rk_test_.
 * Source: STRIPE_LIVE_READ_KEY, else STRIPE_SECRET_KEY in .claude/skills/stripe/.env.
 * Docs: docs/dev/stripe-sandbox.md.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { runScriptAndExit } from '../lib/run-as-script';
import {
  applyPlan,
  createReader,
  createSandboxWriter,
  describePlan,
  planSync,
  upsertSandboxRows,
} from './sync.lib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function readEnvVar(file: string, name: string) {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  return (
    line
      ?.slice(name.length + 1)
      .trim()
      .replace(/^["']|["']$/g, '') || undefined
  );
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const includeInactive = args.includes('--include-inactive');
  const mapOutIdx = args.indexOf('--map-out');
  const mapOut = mapOutIdx >= 0 ? args[mapOutIdx + 1] : undefined;
  const devDb = args.includes('--dev-db');

  const targetKey =
    process.env.STRIPE_SECRET_KEY ?? readEnvVar(resolve(repoRoot, '.env'), 'STRIPE_SECRET_KEY');
  const sourceKey =
    process.env.STRIPE_LIVE_READ_KEY ??
    readEnvVar(resolve(repoRoot, '.claude/skills/stripe/.env'), 'STRIPE_SECRET_KEY');

  if (!sourceKey || !/^(sk|rk)_live_/.test(sourceKey)) {
    throw new Error(
      'No live source key: set STRIPE_LIVE_READ_KEY or STRIPE_SECRET_KEY in .claude/skills/stripe/.env.'
    );
  }
  // Built before any read, so a live target key stops the run before anything is planned.
  const writer = createSandboxWriter(targetKey);
  const live = createReader(sourceKey);
  const sandbox = createReader(targetKey as string);

  const [liveProducts, livePrices, sandboxProducts, sandboxPrices] = await Promise.all([
    live.listProducts(),
    live.listPrices(),
    sandbox.listProducts(),
    sandbox.listPrices(),
  ]);
  const sandboxCatalogue = { products: sandboxProducts, prices: sandboxPrices };
  const steps = planSync({ products: liveProducts, prices: livePrices }, sandboxCatalogue, {
    includeInactive,
  });

  console.log(
    `live: ${liveProducts.length} products, ${livePrices.length} prices; ` +
      `sandbox: ${sandboxProducts.length} products, ${sandboxPrices.length} prices`
  );
  console.log('plan:', JSON.stringify(describePlan(steps)));

  if (!apply) {
    for (const s of steps) {
      const target = 'sandboxId' in s ? ` (${s.sandboxId})` : '';
      const id = 'liveId' in s ? s.liveId : s.liveProductId;
      const name = s.kind === 'createProduct' ? ` "${s.params.name}"` : '';
      console.log(`  ${s.kind} ${id}${target}${name}`);
    }
    if (devDb) {
      const sampled: unknown[][] = [];
      const counts = await upsertSandboxRows(async (_sql, values) => {
        sampled.push(values);
      }, sandboxCatalogue);
      console.log(
        `dev db: would upsert ${counts.products} products, ${counts.prices} prices from the ` +
          `CURRENT sandbox (a first run has none until --apply). Samples:`,
        JSON.stringify(sampled.slice(0, 2))
      );
    }
    console.log('dry run: nothing written. Re-run with --apply.');
    return;
  }

  const ids = await applyPlan(writer, steps, sandboxCatalogue);
  if (mapOut) {
    writeFileSync(mapOut, JSON.stringify(ids, null, 2) + '\n');
    console.log(`wrote live->sandbox id map to ${mapOut}`);
  }

  if (devDb) {
    const url = process.env.DATABASE_URL ?? readEnvVar(resolve(repoRoot, '.env'), 'DATABASE_URL');
    if (!url) throw new Error('--dev-db needs DATABASE_URL');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const synced = { products: await sandbox.listProducts(), prices: await sandbox.listPrices() };
      const counts = await upsertSandboxRows((sql, values) => client.query(sql, values), synced);
      console.log(
        `dev db ${new URL(url).host}: upserted ${counts.products} products, ${counts.prices} prices`
      );
    } finally {
      await client.end();
    }
  }
}

void runScriptAndExit(main);
