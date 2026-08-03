#!/usr/bin/env node
/**
 * Make creators whole for the Early Access price-cap bug (CU 868kk3avk).
 *
 * The per-tier paid-access price caps shipped in 078df52f15 / 3a6bf62700 were applied to every
 * PaidAccess gate, timed Early Access included. Creators below the tier ceiling had their EA
 * windows charged at the cap (free = 500) instead of their stored price. Fixed by 051319720a.
 *
 * This credits each affected creator the difference between the price they set and what buyers
 * were actually charged. Buyers keep their access and are not re-billed.
 *
 * Usage:
 *   node scripts/oneoffs/ea-price-cap-makegood.mjs                # dry run (default)
 *   node scripts/oneoffs/ea-price-cap-makegood.mjs --apply        # write to the prod buzz service
 *   node scripts/oneoffs/ea-price-cap-makegood.mjs --json         # dry run, machine-readable
 *   node scripts/oneoffs/ea-price-cap-makegood.mjs --only 2043827,13261
 *
 * Prod access: BUZZ_ENDPOINT reaches the prod buzz service over the bastion tunnel
 * (LocalForward 28080 -> civitai-buzz-prod). Bring it up first:
 *   node ~/.claude/skills/db-tunnel/tunnel.mjs
 *
 * Idempotent: one credit per creator PER MODEL VERSION, keyed on externalTransactionId. Splitting
 * by version means each credit names the model it is replacing income for, so a creator can
 * reconcile it against their own listing instead of taking one lump sum on faith. A re-run checks
 * the buzz service for each key first and skips anything already settled, so a partial failure is
 * safe to resume by simply running it again.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const BUZZ_ENDPOINT = process.env.BUZZ_ENDPOINT ?? 'http://127.0.0.1:28080';
const CH_QUERY = '.claude/skills/clickhouse-query/query.mjs';
const PG_QUERY = '.claude/skills/postgres-query/query.mjs';

// Bug window. Caps went live with the 07-30 deploy; the fix landed mid-afternoon UTC on 08-01.
// Bounds are deliberately wider than the observed first/last capped sale so a late straggler
// can't slip out; the cap-value test below is what actually selects victims.
const WINDOW_START = '2026-07-30 00:00:00';
const WINDOW_END = '2026-08-01 20:00:00';

// First observed mischarge. Doubles as the trust boundary for `PaidAccess.terms`: a gate last
// touched before this still holds the price that was in force during the bug, so its stored terms
// are authoritative. A gate edited at or after it does not — several creators dropped their price
// while capped, or reset it the moment the fix landed, and paying the stored value would shortchange
// them a second time. For those we fall back to the last price buyers were actually charged.
const BUG_START = '2026-07-31 06:48:34';

// TransactionType.Compensation — same type the daily creator-compensation job uses for
// system -> creator make-goods (src/shared/constants/buzz.constants.ts).
const TRANSACTION_TYPE = 21;
const EXT_ID_PREFIX = 'ea-price-cap-makegood-2026-08-01';
const describe = ({ modelName, versionName, purchases, charged, intended }) =>
  `Credit for Early Access purchase price bug: ${modelName} - ${versionName} ` +
  `(${purchases} ${purchases === 1 ? 'purchase' : 'purchases'} charged ${charged} instead of ${intended})`;

// Charges that landed exactly on a tier ceiling are cap victims. PAID_ACCESS_PRICE_CAP_BY_TIER
// (free 500 / bronze 1000 / silver 5000) times the x5 VIDEO_CAP_MULTIPLIER where it applies.
// A price the creator raised *after* a sale would leave an arbitrary gap, not a round cap value,
// so this test is what keeps ordinary price changes out of the payout.
const CAP_VALUES = new Set([500, 1000, 2500, 5000, 25000]);

// Refuse to pay any single creator more than this without --force. Sized just above the largest
// legitimate claim in the current dataset; a bigger number means the input changed and wants eyes.
const MAX_CREDIT_PER_CREATOR = 750_000;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const APPLY = has('--apply');
const FORCE = has('--force');
const AS_JSON = has('--json');
const ONLY = valueOf('--only')?.split(',').map((s) => Number(s.trim()));

const log = (...a) => { if (!AS_JSON) console.log(...a); };
const fmt = (n) => n.toLocaleString('en-US');

async function runQuery(script, sql) {
  const { stdout } = await execFileAsync('node', [script, '--json', '-q', sql], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const start = stdout.indexOf('{');
  const parsed = JSON.parse(stdout.slice(start));
  return parsed.rows ?? parsed.data ?? [];
}

/** Buyer-facing price for one purchase, per the gate's stored terms. */
function intendedPrice(terms, accessType) {
  const t = typeof terms === 'string' ? JSON.parse(terms) : terms;
  const download = t.download?.price;
  if (accessType === 'download') return download;
  const generation = t.generation;
  if (!generation || 'free' in generation) return undefined;
  return generation.price ?? download;
}

async function buzzRequest(urlPart, init) {
  const res = await fetch(`${BUZZ_ENDPOINT}${urlPart}`, init);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`buzz ${init?.method ?? 'GET'} ${urlPart} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  log(`buzz endpoint: ${BUZZ_ENDPOINT}`);
  const alive = await fetch(BUZZ_ENDPOINT, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!alive) {
    console.error(`Cannot reach the buzz service at ${BUZZ_ENDPOINT}.`);
    console.error('Bring the bastion tunnel up: node ~/.claude/skills/db-tunnel/tunnel.mjs');
    process.exit(1);
  }

  log('loading purchases from ClickHouse...');
  const purchases = await runQuery(
    CH_QUERY,
    `SELECT transactionId, toString(dt) dt, buyer, seller, amt, mv, accessType
     FROM (
       SELECT transactionId, any(date) dt, any(fromAccountId) buyer, any(toAccountId) seller,
              toInt64(any(amount)) amt, JSONExtractInt(any(details),'modelVersionId') mv,
              JSONExtractString(any(details),'type') accessType
       FROM default.buzzTransactions
       WHERE date >= toDateTime('${WINDOW_START}') AND date <= toDateTime('${WINDOW_END}')
         AND type='purchase' AND fromAccountId>0 AND toAccountId>0
       GROUP BY transactionId
     ) ORDER BY dt`
  );

  log('loading paid-access gates from Postgres...');
  const gates = await runQuery(
    PG_QUERY,
    `SELECT p."entityId" mv, p."ownerId", p."timeframeDays", p.terms::text terms, p."updatedAt",
            v.name "versionName", m.name "modelName", m.id "modelId"
     FROM "PaidAccess" p
     JOIN "ModelVersion" v ON v.id = p."entityId"
     JOIN "Model" m ON m.id = v."modelId"
     WHERE p."entityType"='ModelVersion'`
  );
  const gateBy = new Map(gates.map((g) => [Number(g.mv), g]));

  log('loading last pre-bug sale price per version...');
  const preBug = await runQuery(
    CH_QUERY,
    `SELECT mv, accessType, argMax(amt, dt) lastPrice, count() txPre
     FROM (
       SELECT transactionId, any(date) dt, toInt64(any(amount)) amt,
              JSONExtractInt(any(details),'modelVersionId') mv,
              JSONExtractString(any(details),'type') accessType
       FROM default.buzzTransactions
       WHERE type='purchase' AND fromAccountId>0 AND toAccountId>0
         AND date < toDateTime('${BUG_START}') AND date >= toDateTime('2026-06-01 00:00:00')
       GROUP BY transactionId
     ) GROUP BY mv, accessType`
  );
  const preBugBy = new Map(preBug.map((r) => [`${r.mv}:${r.accessType}`, r]));

  const affected = [];
  const skipped = { noGate: 0, permanent: 0, noPrice: 0, notCapped: 0, noShortfall: 0 };

  for (const p of purchases) {
    const mv = Number(p.mv);
    const charged = Number(p.amt);
    const gate = gateBy.get(mv);
    if (!gate) { skipped.noGate++; continue; }
    // Caps were only ever meant to bind permanent gates; only timed windows were mischarged.
    if (gate.timeframeDays == null) { skipped.permanent++; continue; }
    const stored = intendedPrice(gate.terms, p.accessType);
    const observed = preBugBy.get(`${mv}:${p.accessType}`);
    const termsEditedAfterBugStart = String(gate.updatedAt).replace('T', ' ') >= BUG_START;

    // Stored terms unless the row was edited after the bug began, in which case the last price
    // buyers actually paid is the better witness. Falls back to stored when a version has no
    // pre-bug sales to read a price from.
    let intended = stored;
    let priceSource = 'storedTerms';
    if (termsEditedAfterBugStart && observed) {
      intended = Number(observed.lastPrice);
      priceSource = 'lastPreBugSale';
    } else if (termsEditedAfterBugStart) {
      priceSource = 'storedTerms(edited,unverified)';
    }

    if (intended == null) { skipped.noPrice++; continue; }
    if (intended <= charged) { skipped.noShortfall++; continue; }
    if (!CAP_VALUES.has(charged)) { skipped.notCapped++; continue; }
    affected.push({
      transactionId: p.transactionId,
      dt: p.dt,
      seller: Number(p.seller),
      buyer: Number(p.buyer),
      mv,
      accessType: p.accessType,
      charged,
      intended,
      shortfall: intended - charged,
      priceSource,
      storedPrice: stored,
      observedPrice: observed ? Number(observed.lastPrice) : null,
      modelId: Number(gate.modelId),
      modelName: gate.modelName,
      versionName: gate.versionName,
    });
  }

  // One credit per (creator, version). A creator with three affected versions gets three
  // transactions, each naming its model, so the payout reconciles against their own listings.
  const byVersion = new Map();
  for (const row of affected) {
    if (ONLY && !ONLY.includes(row.seller)) continue;
    const key = `${row.seller}:${row.mv}`;
    const cur = byVersion.get(key) ?? {
      userId: row.seller, mv: row.mv, modelId: row.modelId,
      modelName: row.modelName, versionName: row.versionName,
      purchases: 0, charged: 0, intended: 0, credit: 0,
      unitCharged: new Set(), unitIntended: new Set(), priceSource: row.priceSource,
    };
    cur.purchases++;
    cur.charged += row.charged;
    cur.intended += row.intended;
    cur.credit += row.shortfall;
    cur.unitCharged.add(row.charged);
    cur.unitIntended.add(row.intended);
    byVersion.set(key, cur);
  }

  const one = (set) => (set.size === 1 ? [...set][0] : [...set].sort((a, b) => a - b).join('/'));
  const credits = [...byVersion.values()]
    .map((c) => ({ ...c, unitCharged: one(c.unitCharged), unitIntended: one(c.unitIntended) }))
    .sort((a, b) => b.credit - a.credit || a.userId - b.userId);

  const total = credits.reduce((s, c) => s + c.credit, 0);
  const creatorTotals = new Map();
  for (const c of credits) creatorTotals.set(c.userId, (creatorTotals.get(c.userId) ?? 0) + c.credit);

  log('');
  log(`scanned ${purchases.length} purchases against ${gates.length} gates`);
  log(`skipped: ${JSON.stringify(skipped)}`);
  log(`window:  ${affected[0]?.dt ?? 'n/a'}  ->  ${affected.at(-1)?.dt ?? 'n/a'}`);
  log('');
  log(`${affected.length} mischarged purchases across ${credits.length} versions, ${creatorTotals.size} creators`);
  log(`TOTAL CREDIT: ${fmt(total)} buzz`);
  log('');
  log('    userId        mv  purch    paid  should    credit  source                model');
  for (const c of credits) {
    log(
      `  ${String(c.userId).padStart(8)}  ${String(c.mv).padStart(8)}  ${String(c.purchases).padStart(5)}` +
      `  ${String(c.unitCharged).padStart(6)}  ${String(c.unitIntended).padStart(6)}  ${fmt(c.credit).padStart(8)}` +
      `  ${c.priceSource.padEnd(20)}  ${`${c.modelName} - ${c.versionName}`.slice(0, 48)}`
    );
  }
  log('');
  log('  per creator:');
  for (const [userId, amount] of [...creatorTotals].sort((a, b) => b[1] - a[1])) {
    log(`  ${String(userId).padStart(8)}  ${fmt(amount).padStart(9)}`);
  }

  const oversized = [...creatorTotals].filter(([, amount]) => amount > MAX_CREDIT_PER_CREATOR);
  if (oversized.length && !FORCE) {
    console.error('');
    console.error(`Refusing to run: ${oversized.length} creator(s) over the ${fmt(MAX_CREDIT_PER_CREATOR)} per-creator guard:`);
    for (const [userId, amount] of oversized) console.error(`  ${userId}: ${fmt(amount)}`);
    console.error('Re-check the input, then pass --force if the amounts are right.');
    process.exit(1);
  }

  const receipt = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    window: { start: WINDOW_START, end: WINDOW_END },
    totalCredit: total,
    creators: creatorTotals.size,
    versions: credits.length,
    purchases: affected.length,
    perCreator: Object.fromEntries(creatorTotals),
    credits,
    rows: affected,
    results: [],
  };

  if (!APPLY) {
    log('');
    log('DRY RUN — nothing written. Re-run with --apply to credit.');
    if (AS_JSON) console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  log('');
  log('APPLYING...');
  for (const c of credits) {
    const externalTransactionId = `${EXT_ID_PREFIX}-${c.userId}-${c.mv}`;
    const base = { userId: c.userId, mv: c.mv, amount: c.credit, externalTransactionId };
    const existing = await buzzRequest(`/transactions/${externalTransactionId}`);
    if (existing) {
      log(`  ${c.userId} mv ${c.mv}: already credited, skipping`);
      receipt.results.push({ ...base, status: 'skipped-existing' });
      continue;
    }
    const body = {
      fromAccountId: 0,
      toAccountId: c.userId,
      // Creators are always paid out in yellow on this path; every affected sale credited yellow
      // regardless of which buzz colour the buyer spent.
      toAccountType: 'User',
      amount: c.credit,
      type: TRANSACTION_TYPE,
      description: describe({
        modelName: c.modelName, versionName: c.versionName,
        purchases: c.purchases, charged: c.unitCharged, intended: c.unitIntended,
      }),
      externalTransactionId,
      details: {
        reason: 'earlyAccessPriceCapBug',
        clickup: '868kk3avk',
        modelVersionId: c.mv,
        modelId: c.modelId,
        purchases: c.purchases,
        chargedPrice: c.unitCharged,
        intendedPrice: c.unitIntended,
        chargedTotal: c.charged,
        intendedTotal: c.intended,
        priceSource: c.priceSource,
      },
    };
    try {
      const res = await buzzRequest('/transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      log(`  ${c.userId} mv ${c.mv}: credited ${fmt(c.credit)} buzz (${c.modelName} - ${c.versionName})`);
      receipt.results.push({ ...base, status: 'credited', description: body.description, response: res });
    } catch (err) {
      console.error(`  ${c.userId} mv ${c.mv}: FAILED — ${err.message}`);
      receipt.results.push({ ...base, status: 'failed', error: err.message });
    }
  }

  const credited = receipt.results.filter((r) => r.status === 'credited');
  log('');
  log(`credited ${credited.length}/${credits.length} version credits, ${fmt(credited.reduce((s, r) => s + r.amount, 0))} buzz`);
  const failed = receipt.results.filter((r) => r.status === 'failed');
  if (failed.length) log(`${failed.length} failed — re-run to retry (already-credited creators are skipped)`);

  const out = path.join(process.cwd(), `ea-price-cap-makegood-receipt-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(receipt, null, 2));
  log(`receipt: ${out}`);
  if (AS_JSON) console.log(JSON.stringify(receipt, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
