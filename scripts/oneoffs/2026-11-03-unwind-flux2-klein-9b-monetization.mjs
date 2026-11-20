#!/usr/bin/env node
/**
 * Removes monetization from every Flux.2 Klein 9B / 9B-base model version. The FLUX Non-Commercial
 * License v2.1 that covers those base models does not allow per-generation licensing fees, paid access
 * or early access; the code that refuses new ones shipped separately. This cleans up what already exists.
 * Flux.2 Klein 4B / 4B-base are Apache 2.0 and are never touched: the script fingerprints them before and
 * after so a reviewer can confirm that.
 *
 * What --execute changes, in ONE transaction, for versions on those base models (any status):
 *   1. licensingFee > 0           -> licensingFee, licensingFeeType, licensingFeeSettlementCurrency NULL
 *                                    (the app's "no fee" state; a stored 0 is not used for it).
 *   2. licensingSourceVersionId   -> NULL, so the version inherits no fee from a licensing root.
 *   3. live or pending PaidAccess -> row deleted, the same thing an editor save does when the version is
 *      (endsAt NULL or in the future)  no longer gated. Ended gates (endsAt in the past) are left alone.
 *                                    Purchases (EntityAccess) are not touched, so buyers keep access.
 *                                    Not ended with endsAt = NOW(): process-ending-early-access would then
 *                                    republish every one of them as "New".
 *   4. active DonationGoal on a gate removed in 3 -> active = false (a goal leaves with the gate it funds).
 *   5. ModelVersionMonetization rows -> deleted.
 *   6. earlyAccessTimeFrame > 0     -> 0.
 * Then, after COMMIT, it evicts the app's caches for every touched version through
 * POST /api/v1/model-versions/bust-cache (bustMvCache: exact per-id keys, no pattern purge).
 *
 * Left alone and only reported: fee = 0 rows (charge nothing), sales, pricing slots, ended gates.
 *
 * Usage (bash, from the repo root; the URL is never printed):
 *   dry run, against the prod REPLICA (refuses a primary):
 *     UNWIND_DATABASE_URL=<replica url> node scripts/oneoffs/2026-11-03-unwind-flux2-klein-9b-monetization.mjs --out <dir>
 *   execute, against the PRIMARY (refuses a replica), with the counts the dry run printed:
 *     UNWIND_DATABASE_URL=<primary url> CIVITAI_API_KEY=<moderator key> node <this> --execute \
 *       --expect-fees N --expect-sources N --expect-gates N --expect-goals N --expect-monetization N \
 *       --expect-ea N --out <dir>
 *   rehearsal: add --rehearse to an --execute run to do every write and check, then ROLL BACK (no bust).
 *   Meant for the dev database; it still takes row locks for the length of the transaction.
 *   bust only (after a commit whose bust step failed), from the execute output:
 *     CIVITAI_API_KEY=<moderator key> node <this> --bust-only <dir>/executed.json
 *
 * Any count that differs from its --expect-* value rolls the whole transaction back.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const BASES = ['Flux.2 Klein 9B', 'Flux.2 Klein 9B-base'];
const CONTROL_BASES = ['Flux.2 Klein 4B', 'Flux.2 Klein 4B-base'];
const SITE = process.env.CIVITAI_URL ?? 'https://civitai.com';
const BUST_CHUNK = 500; // the endpoint's max

function parseArgs(argv) {
  const args = { execute: false, rehearse: false, out: null, bustOnly: null, expect: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') args.execute = true;
    else if (a === '--rehearse') args.rehearse = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--bust-only') args.bustOnly = argv[++i];
    else if (a.startsWith('--expect-')) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${a} needs a whole number`);
      args.expect[a.slice('--expect-'.length)] = n;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const EXPECT_KEYS = ['fees', 'sources', 'gates', 'goals', 'monetization', 'ea'];

// The candidate set. Every query takes the base list as $1 so the scope is written exactly once.
const SQL = {
  versions: `
    SELECT mv.id AS "versionId", mv."modelId", m."userId", mv."baseModel", mv.status::text AS status,
           mv."licensingFee"::text AS "licensingFee", mv."licensingFeeType"::text AS "licensingFeeType",
           mv."licensingFeeSettlementCurrency"::text AS "licensingFeeSettlementCurrency",
           mv."licensingSourceVersionId", mv."earlyAccessTimeFrame"
    FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
    WHERE mv."baseModel" = ANY($1::text[])
      AND (mv."licensingFee" > 0 OR mv."licensingSourceVersionId" IS NOT NULL OR mv."earlyAccessTimeFrame" > 0
           OR EXISTS (SELECT 1 FROM "PaidAccess" pa WHERE pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
                        AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW()))
           OR EXISTS (SELECT 1 FROM "ModelVersionMonetization" x WHERE x."modelVersionId" = mv.id))
    ORDER BY mv.id`,
  gates: `
    SELECT pa."entityId" AS "versionId", pa."ownerId", pa."endsAt", pa."timeframeDays", pa.terms, pa."createdAt",
           (SELECT count(*)::int FROM "EntityAccess" ea
             WHERE ea."accessToType" = 'ModelVersion' AND ea."accessToId" = pa."entityId") AS buyers
    FROM "PaidAccess" pa JOIN "ModelVersion" mv ON mv.id = pa."entityId"
    WHERE pa."entityType" = 'ModelVersion' AND mv."baseModel" = ANY($1::text[])
      AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW())
    ORDER BY pa."entityId"`,
  goals: `
    SELECT d.id AS "goalId", COALESCE(CASE WHEN d."entityType" = 'ModelVersion' THEN d."entityId" END, d."modelVersionId") AS "versionId",
           d."goalAmount", (SELECT COALESCE(sum(x.amount), 0)::int FROM "Donation" x WHERE x."donationGoalId" = d.id) AS donated
    FROM "DonationGoal" d
    WHERE d.active
      AND COALESCE(CASE WHEN d."entityType" = 'ModelVersion' THEN d."entityId" END, d."modelVersionId") IN (
        SELECT pa."entityId" FROM "PaidAccess" pa JOIN "ModelVersion" mv ON mv.id = pa."entityId"
        WHERE pa."entityType" = 'ModelVersion' AND mv."baseModel" = ANY($1::text[])
          AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW()))
    ORDER BY d.id`,
  monetization: `
    SELECT x.id, x."modelVersionId" AS "versionId", x.type::text AS type, x."unitAmount"
    FROM "ModelVersionMonetization" x JOIN "ModelVersion" mv ON mv.id = x."modelVersionId"
    WHERE mv."baseModel" = ANY($1::text[]) ORDER BY x.id`,
  // Reported, never written.
  byBase: `
    SELECT mv."baseModel" AS base, mv.status::text AS status,
      count(*) FILTER (WHERE mv."licensingFee" > 0)::int AS "feePositive",
      count(*) FILTER (WHERE mv."licensingFee" = 0)::int AS "feeZero",
      count(*) FILTER (WHERE mv."licensingSourceVersionId" IS NOT NULL)::int AS "inheritsFee",
      count(*) FILTER (WHERE pa."entityId" IS NOT NULL AND pa."endsAt" IS NULL AND pa."timeframeDays" IS NULL)::int AS "gatePermanent",
      count(*) FILTER (WHERE pa."entityId" IS NOT NULL AND pa."timeframeDays" IS NOT NULL AND pa."endsAt" IS NULL)::int AS "gateTimedPending",
      count(*) FILTER (WHERE pa."entityId" IS NOT NULL AND pa."endsAt" > NOW())::int AS "gateTimedRunning",
      count(*) FILTER (WHERE pa."entityId" IS NOT NULL AND pa."endsAt" <= NOW())::int AS "gateEnded",
      count(*) FILTER (WHERE mv."earlyAccessTimeFrame" > 0)::int AS "eaTimeFrame"
    FROM "ModelVersion" mv
    LEFT JOIN "PaidAccess" pa ON pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
    WHERE mv."baseModel" = ANY($1::text[])
    GROUP BY 1, 2 ORDER BY 1, 2`,
  derivedFromScope: `
    SELECT count(*)::int AS n FROM "ModelVersion" d
    WHERE d."licensingSourceVersionId" IN (SELECT id FROM "ModelVersion" WHERE "baseModel" = ANY($1::text[]))
      AND NOT (d."baseModel" = ANY($1::text[]))`,
  roots: `SELECT count(*)::int AS n FROM "LicensingRoot" lr JOIN "ModelVersion" mv ON mv.id = lr."modelVersionId"
          WHERE mv."baseModel" = ANY($1::text[]) OR lr."baseModel" = ANY($1::text[])`,
  sales: `SELECT count(*)::int AS n FROM "ModelVersionSaleItem" si JOIN "ModelVersionSale" s ON s.id = si."saleId"
          JOIN "ModelVersion" mv ON mv.id = si."modelVersionId"
          WHERE mv."baseModel" = ANY($1::text[]) AND s."canceledAt" IS NULL AND s."endsAt" > NOW()`,
  slots: `SELECT count(*)::int AS n FROM "PricingSlot" ps JOIN "ModelVersion" mv ON mv.id = ps."entityId"
          WHERE ps."entityType" = 'ModelVersion' AND mv."baseModel" = ANY($1::text[])`,
  // Order-independent fingerprint of everything this script could touch, for the untouched control.
  fingerprint: `
    SELECT count(*)::int AS versions,
      count(*) FILTER (WHERE mv."licensingFee" > 0)::int AS "feePositive",
      count(pa."entityId") FILTER (WHERE pa."endsAt" IS NULL OR pa."endsAt" > NOW())::int AS "liveGates",
      md5(COALESCE(string_agg(concat_ws(',', mv.id, mv."licensingFee", mv."licensingFeeType", mv."licensingFeeSettlementCurrency",
        mv."licensingSourceVersionId", mv."earlyAccessTimeFrame", pa."endsAt", pa."timeframeDays", pa.terms::text,
        (SELECT string_agg(concat_ws(':', d.id, d.active), ';' ORDER BY d.id) FROM "DonationGoal" d
          WHERE d."modelVersionId" = mv.id OR (d."entityType" = 'ModelVersion' AND d."entityId" = mv.id))),
        '|' ORDER BY mv.id), '')) AS md5
    FROM "ModelVersion" mv
    LEFT JOIN "PaidAccess" pa ON pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
    WHERE mv."baseModel" = ANY($1::text[])`,
};

async function rows(client, sql, params = [BASES]) {
  return (await client.query(sql, params)).rows;
}

async function readPlan(client) {
  const [versions, gates, goals, monetization] = await Promise.all([
    rows(client, SQL.versions),
    rows(client, SQL.gates),
    rows(client, SQL.goals),
    rows(client, SQL.monetization),
  ]);
  return { versions, gates, goals, monetization };
}

function counts(plan) {
  return {
    fees: plan.versions.filter((v) => v.licensingFee != null && Number(v.licensingFee) > 0).length,
    sources: plan.versions.filter((v) => v.licensingSourceVersionId != null).length,
    gates: plan.gates.length,
    goals: plan.goals.length,
    monetization: plan.monetization.length,
    ea: plan.versions.filter((v) => v.earlyAccessTimeFrame > 0).length,
  };
}

async function readReport(client) {
  const [byBase, derived, roots, sales, slots, scope, control] = await Promise.all([
    rows(client, SQL.byBase, [[...BASES, ...CONTROL_BASES]]),
    rows(client, SQL.derivedFromScope),
    rows(client, SQL.roots),
    rows(client, SQL.sales),
    rows(client, SQL.slots),
    rows(client, SQL.fingerprint, [BASES]),
    rows(client, SQL.fingerprint, [CONTROL_BASES]),
  ]);
  return {
    byBase,
    derivedOnOtherBasesFromScope: derived[0].n,
    licensingRootsInScope: roots[0].n,
    activeSaleItemsInScope: sales[0].n,
    pricingSlotsInScope: slots[0].n,
    scopeFingerprint: scope[0],
    controlFingerprint: control[0],
  };
}

// Joins the plan into one row per touched version: what changes, and who owns it.
function perVersion(plan) {
  const by = new Map();
  const get = (id) => {
    if (!by.has(id)) by.set(id, { versionId: id, changes: [] });
    return by.get(id);
  };
  for (const v of plan.versions) {
    const r = get(v.versionId);
    Object.assign(r, {
      modelId: v.modelId,
      userId: v.userId,
      baseModel: v.baseModel,
      status: v.status,
    });
    if (v.licensingFee != null && Number(v.licensingFee) > 0)
      r.changes.push(
        `fee ${v.licensingFee} ${v.licensingFeeType ?? ''}/${
          v.licensingFeeSettlementCurrency ?? ''
        }`.trim()
      );
    if (v.licensingSourceVersionId != null)
      r.changes.push(`licensing source ${v.licensingSourceVersionId}`);
    if (v.earlyAccessTimeFrame > 0)
      r.changes.push(`earlyAccessTimeFrame ${v.earlyAccessTimeFrame}`);
  }
  for (const g of plan.gates) {
    const kind =
      g.timeframeDays == null
        ? 'permanent'
        : g.endsAt
        ? `timed until ${g.endsAt.toISOString()}`
        : `timed ${g.timeframeDays}d pending`;
    get(g.versionId).changes.push(`gate ${kind}, ${g.buyers} buyers keep access`);
  }
  for (const d of plan.goals)
    get(d.versionId).changes.push(`goal ${d.goalId} deactivated (${d.donated}/${d.goalAmount})`);
  for (const x of plan.monetization)
    get(x.versionId).changes.push(`monetization ${x.type} removed`);
  return [...by.values()].sort((a, b) => a.versionId - b.versionId);
}

async function banner(client, wantPrimary) {
  const {
    rows: [s],
  } = await client.query(
    `SELECT current_user AS "user", current_database() AS db, inet_server_addr()::text AS addr,
            inet_server_port() AS port, pg_is_in_recovery() AS replica`
  );
  console.error(`Target: ${s.user}@${s.addr}:${s.port}/${s.db}, in recovery: ${s.replica}`);
  if (wantPrimary && s.replica)
    throw new Error('--execute needs the PRIMARY; this server is a replica');
  if (!wantPrimary && !s.replica)
    throw new Error('A dry run reads the REPLICA; this server is a primary. Refusing.');
  if (s.db !== 'civitai') console.error(`WARNING: database is "${s.db}", not "civitai"`);
}

function printSummary(c, report, versions) {
  console.log(
    '\n== Scope: Flux.2 Klein 9B + 9B-base (all statuses), control: Flux.2 Klein 4B + 4B-base =='
  );
  console.table(report.byBase);
  console.log('Changes --execute would make:', c);
  console.log(
    `Touched versions: ${versions.length}, models: ${
      new Set(versions.map((v) => v.modelId)).size
    }, creators: ${new Set(versions.map((v) => v.userId)).size}`
  );
  console.log('Reported only (not written):', {
    derivedOnOtherBasesFromScope: report.derivedOnOtherBasesFromScope,
    licensingRootsInScope: report.licensingRootsInScope,
    activeSaleItemsInScope: report.activeSaleItemsInScope,
    pricingSlotsInScope: report.pricingSlotsInScope,
  });
  console.log('Scope fingerprint:  ', report.scopeFingerprint);
  console.log(
    'Control fingerprint:',
    report.controlFingerprint,
    '(must be identical before and after)'
  );
}

function writeOut(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.error(`Wrote ${file}`);
}

async function bust(versions) {
  const key = process.env.CIVITAI_API_KEY;
  if (!key) throw new Error('CIVITAI_API_KEY (a moderator key) is required to evict caches');
  const ids = versions.map((v) => v.versionId);
  let total = 0;
  for (let i = 0; i < ids.length; i += BUST_CHUNK) {
    const chunk = ids.slice(i, i + BUST_CHUNK);
    // No Origin header: a Bearer request carrying one runs signed out.
    const res = await fetch(`${SITE}/api/v1/model-versions/bust-cache`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionIds: chunk }),
    });
    const body = await res.json().catch(() => ({}));
    // The endpoint drops ids the caller does not own unless it is a moderator, and answers 200 either way.
    if (!res.ok || body.busted !== chunk.length)
      throw new Error(
        `bust-cache: HTTP ${res.status}, busted ${body.busted ?? '?'} of ${chunk.length}`
      );
    total += body.busted;
  }
  console.log(`Cache evicted for ${total} of ${ids.length} versions`);
}

async function execute(client, args) {
  const missing = EXPECT_KEYS.filter((k) => args.expect[k] === undefined);
  if (missing.length)
    throw new Error(`--execute needs --expect-${missing.join(', --expect-')} (from the dry run)`);

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    // Lock the candidate rows so a concurrent editor save cannot change the set under us.
    await client.query(
      `SELECT mv.id FROM "ModelVersion" mv WHERE mv.id = ANY($1::int[]) FOR UPDATE`,
      [
        (await rows(client, SQL.versions))
          .map((v) => v.versionId)
          .concat((await rows(client, SQL.gates)).map((g) => g.versionId)),
      ]
    );
    const controlBefore = (await rows(client, SQL.fingerprint, [CONTROL_BASES]))[0];
    const plan = await readPlan(client);
    const c = counts(plan);
    const off = EXPECT_KEYS.filter((k) => c[k] !== args.expect[k]);
    if (off.length)
      throw new Error(
        `Counts moved since the dry run: ${off
          .map((k) => `${k} ${c[k]} != ${args.expect[k]}`)
          .join(', ')}`
      );

    const versionIds = plan.versions.map((v) => v.versionId);
    const gateIds = plan.gates.map((g) => g.versionId);
    const done = {};
    done.fees = (
      await client.query(
        `UPDATE "ModelVersion" SET "licensingFee" = NULL, "licensingFeeType" = NULL, "licensingFeeSettlementCurrency" = NULL, "updatedAt" = NOW()
       WHERE id = ANY($1::int[]) AND "licensingFee" > 0`,
        [versionIds]
      )
    ).rowCount;
    done.sources = (
      await client.query(
        `UPDATE "ModelVersion" SET "licensingSourceVersionId" = NULL, "updatedAt" = NOW()
       WHERE id = ANY($1::int[]) AND "licensingSourceVersionId" IS NOT NULL`,
        [versionIds]
      )
    ).rowCount;
    done.ea = (
      await client.query(
        `UPDATE "ModelVersion" SET "earlyAccessTimeFrame" = 0, "updatedAt" = NOW()
       WHERE id = ANY($1::int[]) AND "earlyAccessTimeFrame" > 0`,
        [versionIds]
      )
    ).rowCount;
    done.goals = (
      await client.query(
        `UPDATE "DonationGoal" SET active = false WHERE id = ANY($1::int[]) AND active`,
        [plan.goals.map((d) => d.goalId)]
      )
    ).rowCount;
    done.gates = (
      await client.query(
        `DELETE FROM "PaidAccess" WHERE "entityType" = 'ModelVersion' AND "entityId" = ANY($1::int[])
         AND ("endsAt" IS NULL OR "endsAt" > NOW())`,
        [gateIds]
      )
    ).rowCount;
    if (done.gates)
      await client.query(
        `UPDATE "ModelVersion" SET "updatedAt" = NOW() WHERE id = ANY($1::int[])`,
        [gateIds]
      );
    done.monetization = (
      await client.query(`DELETE FROM "ModelVersionMonetization" WHERE id = ANY($1::int[])`, [
        plan.monetization.map((x) => x.id),
      ])
    ).rowCount;

    const wrong = EXPECT_KEYS.filter((k) => done[k] !== c[k]);
    if (wrong.length)
      throw new Error(
        `Write counts differ from the plan: ${wrong
          .map((k) => `${k} ${done[k]} != ${c[k]}`)
          .join(', ')}`
      );
    const after = counts(await readPlan(client));
    if (EXPECT_KEYS.some((k) => after[k] !== 0))
      throw new Error(`Scope not empty after the writes: ${JSON.stringify(after)}`);
    const controlAfter = (await rows(client, SQL.fingerprint, [CONTROL_BASES]))[0];
    if (JSON.stringify(controlAfter) !== JSON.stringify(controlBefore))
      throw new Error(
        `Control (4B) changed: ${JSON.stringify(controlBefore)} -> ${JSON.stringify(controlAfter)}`
      );

    if (args.rehearse) {
      await client.query('ROLLBACK');
      console.log('REHEARSAL: every check passed, ROLLED BACK. Would have written:', done);
      return { plan, done };
    }
    await client.query('COMMIT');
    console.log('COMMITTED:', done);
    console.log('Control fingerprint unchanged:', controlAfter);
    return { plan, done };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('ROLLED BACK. Nothing was written.');
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.bustOnly) {
    const saved = JSON.parse(fs.readFileSync(args.bustOnly, 'utf8'));
    await bust(saved.versions);
    return;
  }

  const url = process.env.UNWIND_DATABASE_URL;
  if (!url)
    throw new Error(
      'Set UNWIND_DATABASE_URL (the replica for a dry run, the primary for --execute)'
    );
  if (!args.out)
    throw new Error('--out <dir> is required (outside the repo: the files name creators)');
  if (args.rehearse && !args.execute) throw new Error('--rehearse goes with --execute');
  if (args.execute && !args.rehearse && !process.env.CIVITAI_API_KEY)
    throw new Error('--execute needs CIVITAI_API_KEY for the cache evict');

  const client = new pg.Client({
    connectionString: url,
    application_name: 'unwind-flux2-klein-9b',
  });
  await client.connect();
  try {
    await banner(client, args.execute);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (!args.execute) {
      const plan = await readPlan(client);
      const report = await readReport(client);
      const versions = perVersion(plan);
      printSummary(counts(plan), report, versions);
      writeOut(args.out, `dry-run-${stamp}.json`, {
        at: new Date(),
        counts: counts(plan),
        report,
        versions,
        plan,
      });
      console.log(
        `\nDry run only. To execute: --execute ${EXPECT_KEYS.map(
          (k) => `--expect-${k} ${counts(plan)[k]}`
        ).join(' ')}`
      );
      return;
    }

    const { plan, done } = await execute(client, args);
    if (args.rehearse) return;
    const versions = perVersion(plan);
    // Written before the bust so a failed bust can be retried with --bust-only.
    writeOut(args.out, 'executed.json', { at: new Date(), done, versions, plan });
    await bust(versions);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
