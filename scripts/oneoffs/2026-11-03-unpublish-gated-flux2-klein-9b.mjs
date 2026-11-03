#!/usr/bin/env node
/**
 * Option A of the Flux.2 Klein 9B clean-up. The FLUX Non-Commercial License v2.1 that covers Klein 9B /
 * 9B-base does not allow per-generation licensing fees, paid access or early access. Instead of freeing
 * the paid versions (the sibling unwind script), this takes every PUBLISHED version behind a live paid
 * gate offline until its creator republishes it as free:
 *
 *   1. In ONE transaction (primary): licensingFee > 0 -> NULL (with its type and currency),
 *      licensingSourceVersionId -> NULL, earlyAccessTimeFrame > 0 -> 0, ModelVersionMonetization rows
 *      deleted, and meta.unpublishedReason / meta.customMessage left by an earlier take-down removed
 *      from the versions step 3 unpublishes (no other meta key may change). Any count that differs from its --expect-* value rolls the whole transaction back, and
 *      the Flux.2 Klein 4B / 4B-base fingerprint must not move.
 *   2. After COMMIT: exact-key cache evictions for every version step 1 touched
 *      (POST /api/v1/model-versions/bust-cache).
 *   3. Every Published 9B version with a live or pending PaidAccess gate is unpublished through the
 *      app's own moderator path (tRPC modelVersion.unpublish, no reason): plain Unpublished, posts
 *      unpublished, search and caches updated, and the model unpublished with its last live version.
 *      No reason means the owner may republish, and no system notification is sent; the creator notice
 *      goes out separately. The gate and its donation goals stay on file: the publish paths refuse a
 *      non-commercial version with an open gate (assertNonCommercialVersionsUnmonetized), so the version
 *      stays down until its owner turns paid access off.
 *      Versions already not Published are skipped, so a re-run continues where a failed one stopped.
 *
 * Purchases (EntityAccess) are not touched. While a version is unpublished nobody but its owner and
 * moderators can download it or generate with it, buyers included.
 *
 * Usage (bash, from the repo root; URLs and keys are never printed):
 *   dry run, against the prod REPLICA (refuses a primary):
 *     UNWIND_DATABASE_URL=<replica url> node <this> --out <dir>
 *   execute, against the PRIMARY (refuses a replica), with the counts the dry run printed:
 *     UNWIND_DATABASE_URL=<primary url> CIVITAI_API_KEY=<moderator key> node <this> --execute \
 *       --expect-fees N --expect-sources N --expect-monetization N --expect-ea N --expect-unpublish N \
 *       --out <dir>
 *   rehearsal: add --rehearse to --execute to run step 1 and its checks, then ROLL BACK (no steps 2-3).
 *   resume steps 2-3 after a failure, from the execute output (primary URL needed to re-read the gates):
 *     UNWIND_DATABASE_URL=<primary url> CIVITAI_API_KEY=<moderator key> node <this> --resume <dir>/executed.json \
 *       --expect-unpublish N --out <dir>
 *   CIVITAI_URL points steps 2-3 at another site (default https://civitai.com), e.g. a local server on dev.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const BASES = ['Flux.2 Klein 9B', 'Flux.2 Klein 9B-base'];
const CONTROL_BASES = ['Flux.2 Klein 4B', 'Flux.2 Klein 4B-base'];
const SITE = (process.env.CIVITAI_URL ?? 'https://civitai.com').replace(/\/$/, '');
const BUST_CHUNK = 500; // the endpoint's max
const TX_KEYS = ['fees', 'sources', 'monetization', 'ea', 'staleReason'];
const EXPECT_KEYS = [...TX_KEYS, 'unpublish'];

function parseArgs(argv) {
  const args = { execute: false, rehearse: false, out: null, resume: null, expect: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') args.execute = true;
    else if (a === '--rehearse') args.rehearse = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--resume') args.resume = argv[++i];
    else if (a.startsWith('--expect-')) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${a} needs a whole number`);
      args.expect[a.slice('--expect-'.length)] = n;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const LIVE_GATE = `EXISTS (SELECT 1 FROM "PaidAccess" pa WHERE pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
                    AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW()))`;

const SQL = {
  // Step 1 candidates: anything on the 9B bases that charges or inherits a charge (any status).
  versions: `
    SELECT mv.id AS "versionId", mv."modelId", m."userId", mv."baseModel", mv.status::text AS status,
           mv."licensingFee"::text AS "licensingFee", mv."licensingFeeType"::text AS "licensingFeeType",
           mv."licensingFeeSettlementCurrency"::text AS "licensingFeeSettlementCurrency",
           mv."licensingSourceVersionId", mv."earlyAccessTimeFrame"
    FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
    WHERE mv."baseModel" = ANY($1::text[])
      AND (mv."licensingFee" > 0 OR mv."licensingSourceVersionId" IS NOT NULL OR mv."earlyAccessTimeFrame" > 0
           OR EXISTS (SELECT 1 FROM "ModelVersionMonetization" x WHERE x."modelVersionId" = mv.id))
    ORDER BY mv.id`,
  monetization: `
    SELECT x.id, x."modelVersionId" AS "versionId", x.type::text AS type, x."unitAmount"
    FROM "ModelVersionMonetization" x JOIN "ModelVersion" mv ON mv.id = x."modelVersionId"
    WHERE mv."baseModel" = ANY($1::text[]) ORDER BY x.id`,
  // Step 3: Published versions behind a live or pending gate, with what unpublishing them takes along.
  gated: `
    SELECT mv.id AS "versionId", mv."modelId", m."userId", m.status::text AS "modelStatus",
           (SELECT count(*)::int FROM "ModelVersion" o WHERE o."modelId" = mv."modelId" AND o.status = 'Published'
              AND NOT (o."baseModel" = ANY($1::text[]) AND EXISTS (SELECT 1 FROM "PaidAccess" pa
                WHERE pa."entityType" = 'ModelVersion' AND pa."entityId" = o.id AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW()))))
             AS "otherPublished",
           (SELECT count(*)::int FROM "EntityAccess" ea WHERE ea."accessToType" = 'ModelVersion' AND ea."accessToId" = mv.id) AS buyers,
           (SELECT count(*)::int FROM "Post" p WHERE p."modelVersionId" = mv.id AND p."userId" = m."userId" AND p."publishedAt" IS NOT NULL) AS posts,
           (mv.meta ? 'unpublishedReason' OR mv.meta ? 'customMessage') AS "staleReason"
    FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
    WHERE mv."baseModel" = ANY($1::text[]) AND mv.status = 'Published' AND ${LIVE_GATE}
    ORDER BY mv.id`,
  status: `SELECT id, status::text AS status FROM "ModelVersion" WHERE id = ANY($1::int[])`,
  fingerprint: `
    SELECT count(*)::int AS versions,
      count(*) FILTER (WHERE mv."licensingFee" > 0)::int AS "feePositive",
      count(pa."entityId") FILTER (WHERE pa."endsAt" IS NULL OR pa."endsAt" > NOW())::int AS "liveGates",
      count(*) FILTER (WHERE mv.status = 'Published')::int AS published,
      md5(COALESCE(string_agg(concat_ws(',', mv.id, mv.status, mv."licensingFee", mv."licensingFeeType",
        mv."licensingFeeSettlementCurrency", mv."licensingSourceVersionId", mv."earlyAccessTimeFrame",
        pa."endsAt", pa."timeframeDays", pa.terms::text,
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
  const [versions, monetization, gated] = await Promise.all([
    rows(client, SQL.versions),
    rows(client, SQL.monetization),
    rows(client, SQL.gated),
  ]);
  return { versions, monetization, gated };
}

function counts(plan) {
  return {
    fees: plan.versions.filter((v) => v.licensingFee != null && Number(v.licensingFee) > 0).length,
    sources: plan.versions.filter((v) => v.licensingSourceVersionId != null).length,
    monetization: plan.monetization.length,
    ea: plan.versions.filter((v) => v.earlyAccessTimeFrame > 0).length,
    unpublish: plan.gated.length,
    staleReason: plan.gated.filter((g) => g.staleReason).length,
  };
}

// One row per affected version: what changes, and who owns it.
function perVersion(plan) {
  const by = new Map();
  const get = (id) => {
    if (!by.has(id)) by.set(id, { versionId: id, changes: [] });
    return by.get(id);
  };
  for (const v of plan.versions) {
    const r = Object.assign(get(v.versionId), {
      modelId: v.modelId,
      userId: v.userId,
      baseModel: v.baseModel,
      status: v.status,
    });
    if (v.licensingFee != null && Number(v.licensingFee) > 0) r.changes.push('fee removed');
    if (v.licensingSourceVersionId != null) r.changes.push('licensing source removed');
    if (v.earlyAccessTimeFrame > 0) r.changes.push('early access removed');
  }
  for (const x of plan.monetization)
    get(x.versionId).changes.push(`monetization ${x.type} removed`);
  for (const g of plan.gated) {
    const r = Object.assign(get(g.versionId), { modelId: g.modelId, userId: g.userId });
    r.changes.push(
      g.otherPublished === 0 && plan.gated.filter((x) => x.modelId === g.modelId).at(-1) === g
        ? 'unpublished (and the whole model with it)'
        : 'unpublished'
    );
    r.buyers = g.buyers;
  }
  return [...by.values()].sort((a, b) => a.versionId - b.versionId);
}

function summary(plan) {
  const models = new Map();
  for (const g of plan.gated) models.set(g.modelId, g.otherPublished);
  return {
    gatedModels: models.size,
    modelsFullyUnpublished: [...models.values()].filter((n) => n === 0).length,
    buyers: plan.gated.reduce((s, g) => s + g.buyers, 0),
    posts: plan.gated.reduce((s, g) => s + g.posts, 0),
  };
}

async function banner(client, wantPrimary) {
  const {
    rows: [s],
  } = await client.query(
    `SELECT current_user AS "user", current_database() AS db, inet_server_addr()::text AS addr,
            inet_server_port() AS port, pg_is_in_recovery() AS replica`
  );
  console.error(
    `Target: ${s.user}@${s.addr}:${s.port}/${s.db}, in recovery: ${s.replica}; site ${SITE}`
  );
  if (wantPrimary && s.replica)
    throw new Error('--execute needs the PRIMARY; this server is a replica');
  if (!wantPrimary && !s.replica)
    throw new Error('A dry run reads the REPLICA; this server is a primary. Refusing.');
}

function writeOut(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.error(`Wrote ${file}`);
}

function apiKey() {
  const key = process.env.CIVITAI_API_KEY;
  if (!key) throw new Error('CIVITAI_API_KEY (a moderator key) is required');
  return key;
}

async function bust(versionIds) {
  let total = 0;
  for (let i = 0; i < versionIds.length; i += BUST_CHUNK) {
    const chunk = versionIds.slice(i, i + BUST_CHUNK);
    // No Origin header: a Bearer request carrying one runs signed out.
    const res = await fetch(`${SITE}/api/v1/model-versions/bust-cache`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
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
  console.log(`Cache evicted for ${total} of ${versionIds.length} fee versions`);
}

async function unpublishOne(id) {
  // No Origin header, as above. No reason: a moderator without one leaves plain Unpublished.
  const res = await fetch(`${SITE}/api/trpc/modelVersion.unpublish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: { id } }),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text.slice(0, 300);
    try {
      const e = JSON.parse(text);
      message = e.error?.json?.message ?? e.error?.message ?? message;
    } catch {}
    throw new Error(`unpublish ${id}: HTTP ${res.status}: ${message}`);
  }
}

// Step 3. Reads the set from the primary each time, so it is idempotent: what is already down is skipped.
async function unpublishGated(client, expected) {
  const gated = await rows(client, SQL.gated);
  console.log(
    `Gated Published versions now: ${gated.length}${
      expected != null ? ` (expected at most ${expected})` : ''
    }`
  );
  if (expected != null && gated.length > expected)
    throw new Error(
      `More gated Published versions than approved: ${gated.length} > ${expected}. Stopping.`
    );
  const done = [];
  for (const g of gated) {
    const [{ status: before } = {}] = await rows(client, SQL.status, [[g.versionId]]);
    if (before !== 'Published') {
      console.log(`  ${g.versionId}: already ${before} (model went down with a sibling), skipped`);
      continue;
    }
    await unpublishOne(g.versionId);
    const [{ status: after } = {}] = await rows(client, SQL.status, [[g.versionId]]);
    if (after !== 'Unpublished')
      throw new Error(`unpublish ${g.versionId}: status is ${after}, not Unpublished`);
    done.push(g.versionId);
    console.log(`  ${g.versionId}: Published -> Unpublished`);
  }
  const left = await rows(client, SQL.gated);
  if (left.length)
    throw new Error(`Still Published behind a gate: ${left.map((g) => g.versionId).join(', ')}`);
  console.log(`Unpublished ${done.length} versions by call; 0 gated Published versions remain.`);
  return done;
}

async function execute(client, args) {
  const missing = EXPECT_KEYS.filter((k) => args.expect[k] === undefined);
  if (missing.length)
    throw new Error(`--execute needs --expect-${missing.join(', --expect-')} (from the dry run)`);

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    await client.query(`SELECT id FROM "ModelVersion" WHERE id = ANY($1::int[]) FOR UPDATE`, [
      (await rows(client, SQL.versions)).map((v) => v.versionId),
    ]);
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

    const ids = plan.versions.map((v) => v.versionId);
    const done = {};
    done.fees = (
      await client.query(
        `UPDATE "ModelVersion" SET "licensingFee" = NULL, "licensingFeeType" = NULL, "licensingFeeSettlementCurrency" = NULL, "updatedAt" = NOW()
         WHERE id = ANY($1::int[]) AND "licensingFee" > 0`,
        [ids]
      )
    ).rowCount;
    done.sources = (
      await client.query(
        `UPDATE "ModelVersion" SET "licensingSourceVersionId" = NULL, "updatedAt" = NOW()
         WHERE id = ANY($1::int[]) AND "licensingSourceVersionId" IS NOT NULL`,
        [ids]
      )
    ).rowCount;
    done.ea = (
      await client.query(
        `UPDATE "ModelVersion" SET "earlyAccessTimeFrame" = 0, "updatedAt" = NOW()
         WHERE id = ANY($1::int[]) AND "earlyAccessTimeFrame" > 0`,
        [ids]
      )
    ).rowCount;
    done.monetization = (
      await client.query(`DELETE FROM "ModelVersionMonetization" WHERE id = ANY($1::int[])`, [
        plan.monetization.map((x) => x.id),
      ])
    ).rowCount;
    // A reason left in meta by an earlier take-down survives the unpublish below (it spreads the
    // existing meta) and would send the creator a "model-version-unpublished" notice naming it.
    const staleIds = plan.gated.filter((g) => g.staleReason).map((g) => g.versionId);
    const metaBefore = await rows(
      client,
      `SELECT id, meta - 'unpublishedReason' - 'customMessage' AS rest FROM "ModelVersion" WHERE id = ANY($1::int[]) ORDER BY id`,
      [staleIds]
    );
    done.staleReason = (
      await client.query(
        `UPDATE "ModelVersion" SET meta = meta - 'unpublishedReason' - 'customMessage'
         WHERE id = ANY($1::int[]) AND (meta ? 'unpublishedReason' OR meta ? 'customMessage')`,
        [staleIds]
      )
    ).rowCount;
    const metaAfter = await rows(
      client,
      `SELECT id, meta AS rest FROM "ModelVersion" WHERE id = ANY($1::int[]) ORDER BY id`,
      [staleIds]
    );
    if (JSON.stringify(metaAfter) !== JSON.stringify(metaBefore))
      throw new Error('Clearing the stale unpublish reason changed other meta keys');

    const wrong = TX_KEYS.filter((k) => done[k] !== c[k]);
    if (wrong.length)
      throw new Error(
        `Write counts differ from the plan: ${wrong
          .map((k) => `${k} ${done[k]} != ${c[k]}`)
          .join(', ')}`
      );
    const after = counts(await readPlan(client));
    if (TX_KEYS.some((k) => after[k] !== 0))
      throw new Error(`Scope not empty after the writes: ${JSON.stringify(after)}`);
    if (after.unpublish !== c.unpublish)
      throw new Error(
        `The transaction changed the gated set: ${c.unpublish} -> ${after.unpublish}`
      );
    const controlAfter = (await rows(client, SQL.fingerprint, [CONTROL_BASES]))[0];
    if (JSON.stringify(controlAfter) !== JSON.stringify(controlBefore))
      throw new Error(
        `Control (4B) changed: ${JSON.stringify(controlBefore)} -> ${JSON.stringify(controlAfter)}`
      );

    if (args.rehearse) {
      await client.query('ROLLBACK');
      console.log('REHEARSAL: every check passed, ROLLED BACK. Would have written:', done);
      return { plan, done, controlBefore };
    }
    await client.query('COMMIT');
    console.log('COMMITTED:', done);
    return { plan, done, controlBefore };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('ROLLED BACK. Nothing was written.');
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.UNWIND_DATABASE_URL;
  if (!url)
    throw new Error('Set UNWIND_DATABASE_URL (the replica for a dry run, the primary otherwise)');
  if (!args.out)
    throw new Error('--out <dir> is required (outside the repo: the files name creators)');
  if (args.rehearse && !args.execute) throw new Error('--rehearse goes with --execute');
  if ((args.execute && !args.rehearse) || args.resume) apiKey();

  const client = new pg.Client({
    connectionString: url,
    application_name: 'unpublish-gated-flux2-klein-9b',
  });
  await client.connect();
  try {
    await banner(client, args.execute || !!args.resume);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (args.resume) {
      const saved = JSON.parse(fs.readFileSync(args.resume, 'utf8'));
      await bust(saved.feeVersionIds);
      const unpublished = await unpublishGated(client, args.expect.unpublish);
      const control = (await rows(client, SQL.fingerprint, [CONTROL_BASES]))[0];
      writeOut(args.out, `resumed-${stamp}.json`, { at: new Date(), unpublished, control });
      return;
    }

    if (!args.execute) {
      const plan = await readPlan(client);
      const c = counts(plan);
      const versions = perVersion(plan);
      const s = summary(plan);
      const [scope] = await rows(client, SQL.fingerprint, [BASES]);
      const [control] = await rows(client, SQL.fingerprint, [CONTROL_BASES]);
      console.log('\n== Scope: Flux.2 Klein 9B + 9B-base, control: Flux.2 Klein 4B + 4B-base ==');
      console.log('Changes --execute would make:', c);
      console.log('Unpublish reach:', s);
      console.log(
        `Affected versions: ${versions.length}, creators: ${
          new Set(versions.map((v) => v.userId)).size
        }`
      );
      console.log('Scope fingerprint:  ', scope);
      console.log('Control fingerprint:', control, '(must be identical before and after)');
      writeOut(args.out, `dry-run-A-${stamp}.json`, {
        at: new Date(),
        counts: c,
        summary: s,
        scope,
        control,
        versions,
        plan,
      });
      console.log(
        `\nDry run only. To execute: --execute ${EXPECT_KEYS.map(
          (k) => `--expect-${k} ${c[k]}`
        ).join(' ')}`
      );
      return;
    }

    const { plan, done, controlBefore } = await execute(client, args);
    if (args.rehearse) return;
    const feeVersionIds = plan.versions.map((v) => v.versionId);
    // Written before steps 2-3 so a failure there can be resumed with --resume.
    writeOut(args.out, 'executed.json', {
      at: new Date(),
      done,
      feeVersionIds,
      versions: perVersion(plan),
      plan,
    });
    await bust(feeVersionIds);
    const unpublished = await unpublishGated(client, args.expect.unpublish);
    const controlAfter = (await rows(client, SQL.fingerprint, [CONTROL_BASES]))[0];
    // Not locked across the calls, so a creator's own 4B edit can move it: a change here needs a look,
    // and nothing is left to roll back.
    if (JSON.stringify(controlAfter) !== JSON.stringify(controlBefore))
      console.error(
        `WARNING: control (4B) changed while unpublishing: ${JSON.stringify(
          controlBefore
        )} -> ${JSON.stringify(controlAfter)}`
      );
    else console.log('Control fingerprint unchanged:', controlAfter);
    writeOut(args.out, 'unpublished.json', { at: new Date(), unpublished, controlAfter });
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
