// One-off: the legacy-store CUTOVER COPY for the app `strength-finder` (the developer guide's
// "Ask Civitai to copy it at cutover"). Legacy per-viewer `kv` → private collection `sweeps`;
// legacy `shared_kv` → shared collection `picks` under each row's ORIGINAL author and hidden
// state; legacy votes → `vote` marks. The rules and abort reasons are in `plan.ts`.
//
// Every write goes through the document store's own operations (`createDocStore` put and
// mark, `createDocStoreModeration` setHidden) with the row's author as the context's viewer,
// so seq, usage charges, index rows, tallies and the schema-major stamp are the store's, not a
// copy of them. A put is create-only (`ifVersion: 0`).
//
// DRY RUN is the default: it reads, prints a JSON report of counts to stdout, writes the key
// mapping to `--out-dir`, and runs a positive control (the same plan with one shared row's
// author broken in memory must abort). `--execute` writes, only when the plan has no abort
// reason, then re-reads and requires zero pending writes and every pre-existing shared document
// unchanged. Re-running is safe: done work is skipped.
//
// Connections (env): CUTOVER_MAIN_URL (main database, read: the approved manifest),
// CUTOVER_APPS_URL (apps datastore, read: the legacy schema), CUTOVER_APPDATA_URL (the document
// store: a read-only role for a dry run; for --execute a role row-level security binds, which
// the store itself checks before any write).
//
//   pnpm exec tsx scripts/oneoffs/strength-finder-cutover/run.ts --out-dir <dir> [--execute]
//
// The report carries counts and keys, never user ids. Keep the output out of the repo.
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { Pool } from 'pg';
import type { DocStoreClient, DocStoreDb } from '~/server/services/apps/doc-store';
import { createDocStore, createDocStoreModeration } from '~/server/services/apps/doc-store';
import type { DocCollection, DocStoreContext } from '~/server/services/apps/doc-store.types';
import { DEFAULT_DOC_STORE_LIMITS } from '~/server/services/apps/doc-store.types';
import {
  currentCollectionMajors,
  deriveCollectionMajors,
  manifestHistory,
  type ApprovedManifest,
} from '~/server/services/apps/storage-schema-majors';
import { appSchemaIdent, sanitizeAppSlug } from '~/server/utils/apps-slug';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  collectionNeedsPublishScope,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';
import {
  buildPlan,
  keepsAuthor,
  pendingWrites,
  type ExistingDoc,
  type Plan,
  type PlanInput,
  type Usage,
} from './plan';

// Fixed in the script, so the pinned sha pins the scope.
export const BLOCK_ID = 'strength-finder';
export const PRIVATE_COLL = 'sweeps';
export const SHARED_COLL = 'picks';
export const VOTE_MARK = 'vote';
const NS = 'prod';

type AppRow = { id: string; status: string; manifest: unknown; updatedAt: Date };

/** The approved manifest must declare both targets as the copy needs them; else nothing runs. */
export function gateManifest(app: AppRow | undefined) {
  if (!app) throw new Error(`gate: no app_blocks row for ${BLOCK_ID}`);
  if (app.status !== 'approved') throw new Error(`gate: app status is ${app.status}, not approved`);
  const parsed = parseManifestStorage(app.manifest, APP_STORAGE_ALL_FEATURES_ON);
  if (parsed.errors.length > 0) throw new Error(`gate: manifest storage does not parse`);
  const priv = parsed.collections.get(PRIVATE_COLL);
  const shared = parsed.collections.get(SHARED_COLL);
  if (!priv || priv.visibility !== 'private') {
    throw new Error(`gate: approved manifest does not declare ${PRIVATE_COLL} as private`);
  }
  if (!shared || shared.visibility !== 'shared' || shared.write !== 'own') {
    throw new Error(`gate: approved manifest does not declare ${SHARED_COLL} as shared, write own`);
  }
  // `own` is viewer-authored: the shared-item lookup reads this collection for the app.
  if (!collectionNeedsPublishScope(shared))
    throw new Error('gate: picks is not an item collection');
  return { priv, shared, votesDeclared: shared.marks.includes(VOTE_MARK) };
}

/** A transaction on the document store with its row-level-security settings bound. */
async function appdataRead<T>(
  pool: DocStoreDb,
  appId: string,
  fn: (c: DocStoreClient) => Promise<T>
) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query(
      `SELECT set_config('appdata.app_id', $1, true), set_config('appdata.ns', $2, true)`,
      [appId, NS]
    );
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

type Snapshot = Map<string, string>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rows = { rows: any[] };
/** The three databases. A `pg` Pool fits each; the tests pass PGlite-backed ones. */
export type Sources = {
  main: { query(sql: string, params?: unknown[]): Promise<Rows> };
  apps: DocStoreDb;
  appdata: DocStoreDb;
};

export async function readInputs(pools: Sources) {
  const app = (
    await pools.main.query(
      `SELECT id, status, manifest, updated_at AS "updatedAt" FROM app_blocks WHERE block_id = $1`,
      [BLOCK_ID]
    )
  ).rows[0] as AppRow | undefined;
  const gate = gateManifest(app);
  if (!app) throw new Error('unreachable');
  const approved = (
    await pools.main.query(
      `SELECT id, manifest, reviewed_at AS "reviewedAt" FROM app_block_publish_requests
        WHERE app_block_id = $1 AND status = 'approved'`,
      [app.id]
    )
  ).rows as ApprovedManifest[];
  const majors = currentCollectionMajors(
    deriveCollectionMajors(manifestHistory(approved, app.manifest))
  );

  const slug = sanitizeAppSlug(BLOCK_ID);
  if (!slug) throw new Error('bad slug');
  const s = appSchemaIdent(slug);
  const apps = await pools.apps.connect();
  let legacy: {
    kv: Rows['rows'];
    shared: Rows['rows'];
    votes: Rows['rows'];
    counters: number;
    reports: number;
  };
  try {
    await apps.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    const kv = await apps.query(
      `SELECT block_instance_id, user_id, key, value, size_bytes, created_at FROM ${s}.kv`
    );
    const shared = await apps.query(
      `SELECT key, author_user_id, value, size_bytes, hidden_at, hidden_by, created_at FROM ${s}.shared_kv`
    );
    const votes = await apps.query(`SELECT key, user_id FROM ${s}.votes`);
    const counters = await apps.query(`SELECT count(*)::int AS n FROM ${s}.counters`);
    const reports = await apps.query(`SELECT count(*)::int AS n FROM ${s}.shared_kv_reports`);
    legacy = {
      kv: kv.rows,
      shared: shared.rows,
      votes: votes.rows,
      counters: Number(counters.rows[0].n),
      reports: Number(reports.rows[0].n),
    };
  } finally {
    await apps.query('ROLLBACK').catch(() => undefined);
    apps.release();
  }

  const target = await appdataRead(pools.appdata, app.id, async (c) => {
    const docs = await c.query(
      `SELECT coll, scope_uid, key, author_kind, author_uid, data, hidden_at IS NOT NULL AS hidden,
              md5(data::text) || ':' || version || ':' || seq || ':' || (hidden_at IS NOT NULL) AS fp
         FROM appdata.doc WHERE app_id = $1 AND ns = $2 AND coll = ANY($3::text[])`,
      [app.id, NS, [PRIVATE_COLL, SHARED_COLL]]
    );
    const marks = await c.query(
      `SELECT key, user_id FROM appdata.doc_mark WHERE app_id = $1 AND ns = $2 AND coll = $3 AND name = $4`,
      [app.id, NS, SHARED_COLL, VOTE_MARK]
    );
    const usageApp = await c.query(
      `SELECT bytes, docs FROM appdata.usage_app WHERE app_id = $1 AND ns = $2`,
      [app.id, NS]
    );
    const usageUser = await c.query(
      `SELECT user_id, bytes, docs FROM appdata.usage_user WHERE app_id = $1 AND ns = $2`,
      [app.id, NS]
    );
    const rows = (r: { rows: unknown[] }) => r.rows as Rows['rows'];
    return {
      docs: rows(docs),
      marks: rows(marks),
      usageApp: rows(usageApp)[0],
      usageUser: rows(usageUser),
    };
  });

  const toDoc = (r: Record<string, unknown>): ExistingDoc => ({
    key: r.key as string,
    scopeUid: Number(r.scope_uid),
    authorKind: r.author_kind as string,
    authorUid: r.author_uid === null ? null : Number(r.author_uid),
    data: r.data,
    hidden: r.hidden as boolean,
  });
  const usage = (r?: Record<string, unknown>): Usage => ({
    bytes: Number(r?.bytes ?? 0),
    docs: Number(r?.docs ?? 0),
  });

  const input: PlanInput = {
    kv: legacy.kv.map((r) => ({
      blockInstanceId: r.block_instance_id,
      userId: Number(r.user_id),
      key: r.key,
      value: r.value,
      sizeBytes: Number(r.size_bytes),
      createdAt: new Date(r.created_at),
    })),
    shared: legacy.shared.map((r) => ({
      key: r.key,
      authorUserId: r.author_user_id,
      value: r.value,
      sizeBytes: Number(r.size_bytes),
      hiddenAt: r.hidden_at ? new Date(r.hidden_at) : null,
      hiddenBy: r.hidden_by === null ? null : Number(r.hidden_by),
      createdAt: new Date(r.created_at),
    })),
    votes: gate.votesDeclared
      ? legacy.votes.map((r) => ({ key: r.key, userId: Number(r.user_id) }))
      : [],
    counterRows: legacy.counters,
    reportRows: legacy.reports,
    existingPrivate: target.docs.filter((r) => r.coll === PRIVATE_COLL).map(toDoc),
    existingShared: target.docs
      .filter((r) => r.coll === SHARED_COLL && Number(r.scope_uid) === 0)
      .map(toDoc),
    existingVotes: new Set(target.marks.map((r) => `${r.key}\u0000${Number(r.user_id)}`)),
    usageApp: usage(target.usageApp),
    usageUser: new Map(target.usageUser.map((r) => [Number(r.user_id), usage(r)])),
    sharedIndexes: Object.fromEntries(gate.shared.indexes),
    limits: DEFAULT_DOC_STORE_LIMITS,
  };
  const sharedSnapshot: Snapshot = new Map(
    target.docs
      .filter((r) => r.coll === SHARED_COLL)
      .map((r) => [`${r.scope_uid}\u0000${r.key}`, r.fp])
  );
  return {
    app,
    gate,
    majors,
    input,
    sharedSnapshot,
    legacyVotesSkippedUndeclared: gate.votesDeclared ? 0 : legacy.votes.length,
  };
}

/** The executor's only entry check: a plan with any abort reason writes nothing. */
export function assertExecutable(plan: Plan): void {
  if (plan.aborts.length > 0) {
    throw new Error(
      `refusing to execute: ${plan.aborts.map((a) => `${a.reason}=${a.count}`).join(', ')}`
    );
  }
}

/**
 * POSITIVE CONTROL: the same inputs with one shared row's author broken in memory must abort
 * `author_not_kept` and be refused by {@link assertExecutable}. Nothing touches a database.
 */
export function authorControl(input: PlanInput) {
  const notKept = (p: Plan) => p.aborts.find((a) => a.reason === 'author_not_kept')?.count ?? 0;
  const baseline = notKept(buildPlan(input));
  // Break a row whose author IS kept (a real one when there is any), so the count must rise by one.
  const i = input.shared.findIndex((r) => keepsAuthor(r.authorUserId));
  const real = i >= 0 ? input.shared[i] : undefined;
  const broken = {
    ...(real ?? {
      key: 'control-row',
      value: {},
      sizeBytes: 2,
      hiddenAt: null,
      hiddenBy: null,
      createdAt: new Date(0),
    }),
    authorUserId: null,
  };
  const shared = real
    ? input.shared.map((r, j) => (j === i ? broken : r))
    : [...input.shared, broken];
  const plan = buildPlan({ ...input, shared });
  let refused = false;
  try {
    assertExecutable(plan);
  } catch {
    refused = true;
  }
  return {
    authorNotKeptAdded: notKept(plan) - baseline,
    onRealRow: !!real,
    executeRefused: refused,
  };
}

function gitPreflight(execute: boolean) {
  const sha = execSync('git rev-parse HEAD').toString().trim();
  const dirty = execSync(
    'git status --porcelain --untracked-files=no -- scripts/oneoffs/strength-finder-cutover src'
  )
    .toString()
    .trim();
  const pushed = execSync(`git branch -r --contains ${sha}`).toString().trim().length > 0;
  if (execute && (dirty || !pushed)) {
    throw new Error(
      `refusing to execute: ${
        dirty ? 'tracked files differ from HEAD' : 'HEAD is on no remote branch'
      }`
    );
  }
  return { sha, dirty: dirty.length > 0, pushed };
}

export async function execute(
  pool: DocStoreDb,
  appId: string,
  plan: Plan,
  colls: { priv: DocCollection; shared: DocCollection }
) {
  const store = createDocStore({ db: pool });
  const moderation = createDocStoreModeration({ db: pool });
  const ctx = (viewerUid: number): DocStoreContext => ({ appId, ns: NS, viewerUid });
  const done = { privatePuts: 0, sharedPuts: 0, marks: 0, hides: 0 };
  const log = () => process.stderr.write(`  ${JSON.stringify(done)}\n`);

  for (const w of plan.privateWrites) {
    const rec = await store.put(
      ctx(w.userId),
      colls.priv,
      w.key,
      w.data as Record<string, unknown>,
      { ifVersion: 0 }
    );
    if (rec.author.kind !== 'user' || rec.author.uid !== w.userId)
      throw new Error(`author check failed on a private put (${w.key})`);
    if (++done.privatePuts % 200 === 0) log();
  }
  for (const w of plan.sharedWrites) {
    const rec = await store.put(
      ctx(w.authorUid),
      colls.shared,
      w.key,
      w.data as Record<string, unknown>,
      { ifVersion: 0 }
    );
    // By construction the store writes the context's viewer as author; checked anyway, and a
    // mismatch stops the run before anything else is written.
    if (rec.author.kind !== 'user' || rec.author.uid !== w.authorUid)
      throw new Error(`author check failed on ${w.key}`);
    done.sharedPuts++;
    for (const u of w.voters) {
      await store.mark(ctx(u), colls.shared, w.key, VOTE_MARK);
      done.marks++;
    }
    if (w.hideBy !== null) {
      await moderation.setHidden(appId, NS, SHARED_COLL, w.key, true, w.hideBy);
      done.hides++;
    }
    if (done.sharedPuts % 200 === 0) log();
  }
  for (const v of plan.voteWrites) {
    await store.mark(ctx(v.userId), colls.shared, v.key, VOTE_MARK);
    done.marks++;
  }
  for (const h of plan.hideWrites) {
    await moderation.setHidden(appId, NS, SHARED_COLL, h.key, true, h.moderatorUid);
    done.hides++;
  }
  log();
  return done;
}

/**
 * One run: read, plan, control, and (with `execute`) write and read back. Returns the report
 * (counts and keys, no user ids) and the key mapping. Throws on any refusal; a readback failure
 * throws with the report attached as `err.report`.
 */
export async function runCutover(
  sources: Sources,
  opts: { execute: boolean; sha: string; dirty: boolean }
): Promise<{ report: Record<string, unknown>; mapping: Plan['mapping'] }> {
  const before = await readInputs(sources);
  const plan = buildPlan(before.input);
  const control = authorControl(before.input);
  if (control.authorNotKeptAdded !== 1 || !control.executeRefused) {
    throw new Error('positive control failed: a broken author did not abort the plan');
  }
  const report: Record<string, unknown> = {
    script: 'scripts/oneoffs/strength-finder-cutover/run.ts',
    sha: opts.sha,
    dirty: opts.dirty,
    mode: opts.execute ? 'execute' : 'dry-run',
    app: { blockId: BLOCK_ID, appBlockId: before.app.id, manifestUpdatedAt: before.app.updatedAt },
    gate: {
      sweeps: 'private',
      picks: 'shared, write own',
      voteMarkDeclared: before.gate.votesDeclared,
      schemaMajors: Object.fromEntries(before.majors),
    },
    counts: { ...plan.counts, legacyVotesSkippedUndeclared: before.legacyVotesSkippedUndeclared },
    aborts: plan.aborts,
    pendingWrites: pendingWrites(plan),
    positiveControl: control,
  };
  if (!opts.execute) return { report, mapping: plan.mapping };

  assertExecutable(plan);
  const colls = {
    priv: {
      name: PRIVATE_COLL,
      config: before.gate.priv,
      schemaMajor: before.majors.get(PRIVATE_COLL) ?? null,
    },
    shared: {
      name: SHARED_COLL,
      config: before.gate.shared,
      schemaMajor: before.majors.get(SHARED_COLL) ?? null,
    },
  };
  report.executed = await execute(sources.appdata, before.app.id, plan, colls);
  // READBACK: a fresh plan must have nothing left to write, and every shared document that
  // existed before the run (the control set) must be unchanged.
  const after = await readInputs(sources);
  const again = buildPlan(after.input);
  // A resumed run legitimately hides documents it copied earlier: those are not controls.
  const resumed = new Set(plan.hideWrites.map((h) => `0\u0000${h.key}`));
  const controls = [...before.sharedSnapshot].filter(([k]) => !resumed.has(k));
  const changed = controls.filter(([k, fp]) => after.sharedSnapshot.get(k) !== fp).length;
  report.readback = {
    pendingWrites: pendingWrites(again),
    aborts: again.aborts,
    preExistingSharedDocsControls: controls.length,
    preExistingSharedDocsChanged: changed,
    counts: again.counts,
  };
  if (pendingWrites(again) !== 0 || again.aborts.length > 0 || changed !== 0) {
    throw Object.assign(new Error('readback failed'), { report });
  }
  return { report, mapping: plan.mapping };
}

async function main() {
  const args = process.argv.slice(2);
  const isExecute = args.includes('--execute');
  const outIdx = args.indexOf('--out-dir');
  if (outIdx < 0 || !args[outIdx + 1])
    throw new Error('--out-dir <dir> is required (keep it out of the repo)');
  const outDir = resolve(args[outIdx + 1]);
  const git = gitPreflight(isExecute);
  process.stderr.write(
    `strength-finder cutover copy: ${isExecute ? 'EXECUTE' : 'dry run'} at ${git.sha}\n`
  );

  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const pools = {
    main: new Pool({ connectionString: need('CUTOVER_MAIN_URL'), max: 1 }),
    apps: new Pool({ connectionString: need('CUTOVER_APPS_URL'), max: 1 }),
    appdata: new Pool({ connectionString: need('CUTOVER_APPDATA_URL'), max: 2 }),
  };
  const emit = (report: unknown) => process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  try {
    const { report, mapping } = await runCutover(pools, { execute: isExecute, ...git });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'key-mapping.json'), JSON.stringify(mapping, null, 2) + '\n');
    emit({ ...report, mappingFile: join(outDir, 'key-mapping.json') });
  } catch (err) {
    const report = (err as { report?: unknown }).report;
    if (report) emit(report);
    throw err;
  } finally {
    await Promise.all(Object.values(pools).map((p) => p.end()));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
