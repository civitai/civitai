// Which CLASS of database this deployment is pointed at.
//
// WHY THIS EXISTS: `IS_PREVIEW` was being asked to mean two unrelated things —
//
//   (a) "this is a non-production environment"      ← it does mean this
//   (b) "this runs against a non-production database" ← it does NOT mean this
//
// The falsifying case is already deployed. At least two distinct deployment classes set
// `IS_PREVIEW=true`, and they run against DIFFERENT databases: the ephemeral per-change
// deployments use a scratch database, while a standing non-production deployment runs against
// the PRODUCTION database. Any code that branches on `IS_PREVIEW` to decide database-write
// behaviour is therefore already wrong for the latter — it withholds or mislabels rows that
// are going into the real database.
//
// It is not even stable within one deployment class: an ephemeral deployment can be pointed at
// either database by configuration, so the database target is a genuinely independent axis and
// cannot be derived from any environment-identity flag. It has to be stated.
//
// PRECEDENT: the same conflation for redis cache keys was resolved the same way — an explicit,
// separately-set `CACHE_KEY_NAMESPACE` rather than an overload of `IS_PREVIEW`. See
// packages/civitai-redis/src/cache-key-prefix.ts, whose header documents that decision at
// length. This module is the database-side counterpart.
//
// 🔴 UNSET IS "UNKNOWN", NOT "PRODUCTION". The configuration half of this change lands
// separately, so for a while deployments will not carry `DATABASE_ENVIRONMENT` at all. An
// unset value therefore falls back to the LEGACY `IS_PREVIEW` heuristic, which reproduces
// today's behaviour byte-for-byte everywhere:
//
//   * production sets neither variable      → unknown → legacy → NOT a non-production database
//   * ephemeral deployments set IS_PREVIEW  → unknown → legacy → IS a non-production database
//
// Defaulting an unset value to "production database" instead would flip the ephemeral
// deployments the moment this shipped and start writing their scratch-database rows into
// production-shared sinks — the damaging direction. Defaulting it to "non-production database"
// would flip production. Only the legacy fallback is a no-op, so that is the default.
//
// The consequence is that setting `DATABASE_ENVIRONMENT` is REQUIRED to complete the fix: until
// the standing non-production deployment carries `DATABASE_ENVIRONMENT=production`, it keeps
// today's (wrong) behaviour. That is deliberate — a wrong-but-unchanged behaviour is a smaller
// harm than an unreviewed behaviour change on every environment at once.
//
// WHY `process.env` DIRECTLY AND NOT `~/env/server`: same reason as the cache-key module — this
// is one optional string with a total parse and no failure mode, and it is read from code that
// must not acquire a dependency on the validated server schema (or on it having been loaded).
// Reading it cannot throw.
//
// 🔴 SCOPE: this describes the DATABASE, and nothing else. It is not a general "is this
// production" flag and must not become one. `IS_PREVIEW` remains correct for what it actually
// means — environment identity — and still gates auth (src/server/auth/get-server-auth-session.ts)
// and page access (src/server/auth/route-guard.ts). Do not repoint those at this variable.

/** The three states of `DATABASE_ENVIRONMENT`. `unknown` means "not configured", not "neither". */
export type DatabaseEnvironment = 'production' | 'non-production' | 'unknown';

/** The environment variable that carries the signal. Exported so tests name it once. */
export const DATABASE_ENVIRONMENT_VAR = 'DATABASE_ENVIRONMENT';

/**
 * Parse `DATABASE_ENVIRONMENT` into its three states.
 *
 * Strict: only the two documented spellings are recognised (after trim + lowercase). Anything
 * else — a typo, a legacy value, an empty string — is `unknown`, which routes to the legacy
 * fallback rather than to a guessed answer. A misconfigured value must never be silently read
 * as one of the two real answers.
 *
 * `env` is injectable so the matrix can be exercised as literal input/output pairs without
 * mutating the process.
 */
export function resolveDatabaseEnvironment(env: NodeJS.ProcessEnv = process.env): DatabaseEnvironment {
  const raw = env[DATABASE_ENVIRONMENT_VAR]?.trim().toLowerCase();
  if (raw === 'production') return 'production';
  if (raw === 'non-production') return 'non-production';
  return 'unknown';
}

/**
 * `true` when this deployment writes to a database that is NOT production.
 *
 * This is the predicate call sites want: it answers "are the ids and rows I am about to emit
 * from a throwaway dataset?". Read it at CALL time (not module-eval) so a value can be set in a
 * test without a module-graph reset; environment variables do not change at runtime, so there is
 * no behavioural difference in the app.
 *
 * When `DATABASE_ENVIRONMENT` is unset or unrecognised this falls back to `IS_PREVIEW === 'true'`
 * — see the header. That fallback is the ONLY reason production is unaffected by this change, so
 * do not "simplify" it to `false`.
 */
export function isNonProductionDatabase(env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = resolveDatabaseEnvironment(env);
  if (resolved !== 'unknown') return resolved === 'non-production';
  return env.IS_PREVIEW === 'true';
}

/**
 * Whether the answer came from the explicit variable or from the legacy fallback. Exported for
 * diagnostics and for the misconfiguration warning below; call sites should prefer
 * `isNonProductionDatabase`.
 */
export function isDatabaseEnvironmentConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveDatabaseEnvironment(env) !== 'unknown';
}

// Misconfiguration reminder. A deployment that announces itself as non-production but does not
// say which database it is pointed at is running on the legacy heuristic — which is right for the
// ephemeral deployments and wrong for the standing one, and nothing about the process can tell
// which it is. Warn so the pending configuration change stays visible.
//
// 🔴 LOG-ONLY, NEVER THROW, and at most once per process. This module is imported from request
// paths; throwing would fail boot for exactly the deployments that are legitimately mid-migration,
// and warning per call would flood the log.
let warned = false;
export function warnIfDatabaseEnvironmentUnset(env: NodeJS.ProcessEnv = process.env) {
  if (warned) return;
  if (isDatabaseEnvironmentConfigured(env)) return;
  if (env.IS_PREVIEW !== 'true') return;
  warned = true;
  // eslint-disable-next-line no-console
  console.error(
    `🔴 ${DATABASE_ENVIRONMENT_VAR} IS UNSET on a deployment with IS_PREVIEW=true. Database-write ` +
      'behaviour is falling back to the legacy IS_PREVIEW heuristic, which assumes a ' +
      'non-production database — wrong for any non-production deployment that runs against the ' +
      `production database. Set ${DATABASE_ENVIRONMENT_VAR} to "production" or "non-production" ` +
      'on this deployment. See src/env/database-target.ts.'
  );
}
