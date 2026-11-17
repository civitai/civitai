/**
 * Remix apps: does the quoted price equal what the run debits?
 *
 * Calls the `remixApp` router of a running site (this branch, deployed or local) as the API key's
 * user, so the request body is built by the server code under test, not by this script. Per source
 * image it records the quote, then (unless --whatif-only) runs the app once and reads the debit back
 * from the user's Buzz ledger: the account balance before and after, and the transactions written
 * since the run started.
 *
 *   CIVITAI_API_KEY=... pnpm exec tsx scripts/remix-apps/whatif-debit-proof.ts \
 *     --base-url http://localhost:3000 --app anime-it --image 123 --image 456 --max-buzz 200
 *
 * A run spends real Buzz. --max-buzz refuses any run quoted above it.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { clientTransformer } from '../../src/shared/utils/trpc-union-transformer';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    app: { type: 'string', default: 'anime-it' },
    image: { type: 'string', multiple: true },
    'whatif-only': { type: 'boolean', default: false },
    'max-buzz': { type: 'string' },
    'ledger-wait-s': { type: 'string', default: '180' },
  },
});

const apiKey = process.env.CIVITAI_API_KEY;
const imageIds = (values.image ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
if (!apiKey) throw new Error('CIVITAI_API_KEY is not set');
if (!imageIds.length) throw new Error('Pass at least one --image <id>');
const maxBuzz = values['max-buzz'] ? Number(values['max-buzz']) : undefined;
if (!values['whatif-only'] && !(maxBuzz && maxBuzz > 0))
  throw new Error('A real run needs --max-buzz <n>');

const base = values['base-url']!.replace(/\/$/, '');
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

async function trpc<T>(path: string, input: unknown, method: 'GET' | 'POST'): Promise<T> {
  const serialized = JSON.stringify(clientTransformer.input.serialize(input));
  const url =
    method === 'GET'
      ? `${base}/api/trpc/${path}?input=${encodeURIComponent(serialized)}`
      : `${base}/api/trpc/${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: method === 'POST' ? serialized : undefined,
  });
  const body = (await res.json()) as {
    result?: { data: unknown };
    error?: unknown;
  };
  if (!res.ok || body.error) {
    const error = body.error ? clientTransformer.output.deserialize(body.error) : res.statusText;
    throw new Error(`${path} failed (${res.status}): ${JSON.stringify(error)}`);
  }
  return clientTransformer.output.deserialize(body.result!.data) as T;
}

type Quote = {
  prices: ({ slug: string; cost: number; ready: boolean } | { slug: string; refusal: string })[];
};
type Run = { workflowId: string; tier: string; cost: number };
type Accounts = Record<string, number>;
type Transactions = {
  transactions: {
    transactionId?: string;
    date: string | Date;
    amount: number;
    accountType: string;
    description?: string;
    externalTransactionId?: string;
  }[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ledgerSince(start: Date, waitS: number) {
  const deadline = Date.now() + waitS * 1000;
  // The transaction listing is read from an analytics mirror and lags the debit.
  while (Date.now() < deadline) {
    const { transactions } = await trpc<Transactions>(
      'buzz.getUserTransactions',
      { start, end: new Date(Date.now() + 60_000), limit: 50 },
      'GET'
    );
    if (transactions.length) return transactions;
    await sleep(15_000);
  }
  return [];
}

async function main() {
  const report: unknown[] = [];
  for (const imageId of imageIds) {
    const quote = await trpc<Quote>('remixApp.quote', { imageId }, 'GET');
    const price = quote.prices.find((p) => p.slug === values.app);
    if (!price) throw new Error(`No price for ${values.app} on image ${imageId}`);
    const entry: Record<string, unknown> = { imageId, app: values.app, quote: price };
    report.push(entry);
    if (values['whatif-only'] || 'refusal' in price) continue;
    if (price.cost > maxBuzz!) {
      entry.skipped = `quoted ${price.cost} > --max-buzz ${maxBuzz}`;
      continue;
    }

    const before = await trpc<Accounts>('buzz.getBuzzAccount', undefined, 'GET');
    const start = new Date(Date.now() - 5_000);
    const run = await trpc<Run>(
      'remixApp.run',
      { slug: values.app, imageId, nonce: randomUUID() },
      'POST'
    );
    const transactions = await ledgerSince(start, Number(values['ledger-wait-s']));
    const after = await trpc<Accounts>('buzz.getBuzzAccount', undefined, 'GET');
    // Other activity on the account can land in the window; the workflow id names this run's.
    const ours = transactions.filter((t) => JSON.stringify(t).includes(run.workflowId));
    const debited = (ours.length ? ours : transactions).reduce(
      (sum, t) => sum + Math.abs(Math.min(t.amount, 0)),
      0
    );
    Object.assign(entry, {
      workflowId: run.workflowId,
      tier: run.tier,
      runReportedCost: run.cost,
      balanceBefore: before,
      balanceAfter: after,
      ledgerTransactions: transactions,
      ledgerMatchedByWorkflowId: ours.length > 0,
      ledgerDebited: debited,
      quoteEqualsDebit: debited === price.cost,
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
