import { readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';
import { PROVISIONED_AXIOM_DATASTREAMS } from '@civitai/axiom/env';

/**
 * CALL-SITE LEDGER for the Axiom datastream argument.
 *
 * 🔴 THE RELATIONSHIP THIS PINS, and why nothing else could. `logToAxiom(data, datastream)` names
 * its target Axiom dataset as a free-form string. Axiom does not create a dataset on ingest, so a
 * name nobody provisioned is rejected on every write, from every process, forever — and the only
 * symptom is a log line whose `reason` field says `"error"`, a category shared with every transient
 * transport fault. Typecheck cannot see it (it is a `string`), eslint cannot see it (the truth lives
 * in a third-party account), and a behavioural test cannot see it (the fake accepts any name).
 *
 * That is not hypothetical: measured against the ingest org, TEN distinct datastream names in this
 * repo had no dataset behind them, across eighteen call sites in four subsystems. The oldest had
 * been failing 100% of its writes for roughly 76 days without a single alert. No events were lost —
 * `logToAxiom` writes the full structured line to stderr → the log store BEFORE attempting Axiom,
 * and every consumer of these streams already reads the log store or metrics — but the Axiom copy
 * never existed, and nothing could tell you.
 *
 * The runtime half of the fix is the provisioned-dataset guard in `@civitai/axiom` (see
 * `packages/civitai-axiom/src/env.ts`): an unprovisioned name never reaches `ingestEvents`.
 * That guard makes the failure harmless. It does NOT make it visible at authoring time — a new
 * call site naming a new dead dataset is silently Loki-only, which is the same invisibility in a
 * kinder shape.
 *
 * So this ledger closes the authoring half. It enumerates every datastream literal reachable from
 * a production call site and requires each to be either PROVISIONED (a real dataset, so the dual
 * write works) or explicitly listed below as LOKI-ONLY with a reason. It fails when the set GROWS
 * (a new name appears in neither) and when it SHRINKS (a listed name is gone or renamed, so the
 * reasoning recorded here has gone stale).
 *
 * 🔴 A ledger is a structural check and type-checks past a wrong argument, so it is deliberately
 * NOT the only guard. The behavioural half — that a datastream reaching `ingestEvents` is one that
 * is supposed to exist — is pinned in
 * `packages/civitai-axiom/src/__tests__/provisionedDatastreams.test.ts`. This pins the population.
 *
 * ---
 *
 * IF THIS TEST FAILS, you added or changed a datastream argument. Pick one:
 *   - The dataset EXISTS in Axiom → add it to `PROVISIONED_AXIOM_DATASTREAMS`, having actually
 *     checked (`GET /v1/datasets/<name>` → 200), or set `AXIOM_EXTRA_DATASTREAMS` for a rollout
 *     that must not wait on a release.
 *   - The dataset does NOT exist and you do not intend to create one → add it to `LOKI_ONLY` below
 *     with a reason. The events stay on the stderr/log-store path, which is where the platform's
 *     logging is going anyway.
 *   - You meant the default dataset → drop the second argument entirely. Note what that means:
 *     omitting it does not disable the write, it REDIRECTS the event onto `AXIOM_DATASTREAM`, and
 *     rewrites the `_axiom` field the log queries group by.
 */

const ROOT = process.cwd();

/**
 * Datastream names written by production code that have NO Axiom dataset behind them, and are not
 * getting one. The log store is their sink; the Axiom dual-write is skipped by the guard.
 *
 * Every entry was confirmed absent by `GET /v1/datasets/<name>` → 404 against a negative control
 * (`zz-control-not-a-dataset` → 404, proving 404 means absent rather than unauthorized) on
 * 2026-08-24.
 */
/**
 * 🔴 ONE NAME IS DELIBERATELY ABSENT FROM THE LEDGER BELOW, AND IT IS A LANDMINE.
 * `src/server/services/buzz.service.ts` carries a COMMENTED-OUT call passing `'connection-testing'`,
 * a datastream with no dataset (404, same probe and controls as the entries below). The scan blanks
 * comments before collecting, so it is not ledger material today — but uncommenting that line
 * reintroduces exactly this defect, and this test would then fail with it listed as unaccounted,
 * which is the intended outcome. It is left in place rather than deleted: removing it is unrelated
 * scope, and the failure it would cause is now loud instead of silent.
 */
const LOKI_ONLY: Record<string, string> = {
  'app-blocks': 'App Block reward/moderation failures. Alerting on these reads the log store.',
  'app-storage-trpc':
    'App Block shared-storage quota + tRPC storage ops; metrics carry the aggregate.',
  'article-stats': 'Article stat-cache fetch failures; a low-volume error path.',
  auth: 'Legacy session-upgrade mints. The rate is the signal and it is a metric, not a dataset.',
  'block-audit': 'App Block shared-storage abuse reports (metadata only, never reported content).',
  'db-logs': 'Slow-query reports from the Prisma client. Latent — it has never had a dataset.',
  'eventloop-longtask':
    'Event-loop long tasks. The aggregate lives in metrics and the per-event payload in the log store; both are what every existing dashboard and alert already read.',
  moderation: 'Mod-activity tracking failures; a non-fatal catch path.',
  'moderator-app':
    'Moderator-app request failures; the caller rethrows, so the throw is the signal.',
  settings:
    'SSR settings-bootstrap deadline breaches. The reason this must stay visible is the whole point of the call site, and the log-store line is what makes it visible.',
};

/**
 * Files that FORWARD a caller-supplied datastream rather than naming one — the package's own
 * signature and the per-app shims that re-export `logToAxiom` with a default. A pass-through is not
 * a datastream choice, so it is not ledger material; but an UNRECOGNISED non-literal argument is,
 * because it would be a name this test cannot see. Anything dynamic outside this set fails.
 */
const FORWARDING_FILES: ReadonlySet<string> = new Set([
  'packages/civitai-axiom/src/client.ts',
  'apps/auth/src/lib/server/axiom.ts',
  'apps/moderator/src/lib/server/axiom.ts',
  'apps/notifications/src/lib/server/clients/axiom.ts',
]);

const SCAN_ROOTS = ['src', 'apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.svelte-kit', 'dist', 'build', '.turbo']);
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
// Test files are out of scope on purpose: a test may legitimately name any datastream, including
// invented ones. The ledger is about PRODUCTION call sites.
const TEST_FILE = /(\.test\.|\.spec\.|__tests__|__mocks__|(^|[\\/])tests[\\/])/;

/**
 * Blank out comments while preserving offsets, so a commented-out call site is not collected.
 *
 * 🔴 This is a real tokenizer walk rather than a regex, because the naive version is wrong in a way
 * that would quietly corrupt the scan: a `//` inside a string literal (a URL, most obviously) makes
 * a regex stripper eat the rest of the line INCLUDING the closing quote, which unbalances every
 * subsequent string and silently shifts what the parser below thinks is code. Offsets are preserved
 * (comments become spaces) so reported line numbers stay true.
 */
function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

type Found = { file: string; line: number; raw: string; resolved: string | null };

/**
 * Pull the SECOND argument of every `logToAxiom(...)` call by walking balanced brackets, skipping
 * string bodies. A regex cannot do this — the first argument is routinely a multi-line object
 * literal containing commas, parens and braces.
 */
function secondArgs(file: string, src: string): Found[] {
  const found: Found[] = [];
  const CALL = 'logToAxiom(';
  let i = 0;
  while ((i = src.indexOf(CALL, i)) !== -1) {
    const start = i + CALL.length;
    let depth = 1;
    let j = start;
    const argStarts = [start];
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        j++;
        while (j < src.length) {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (src[j] === quote) break;
          j++;
        }
        j++;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) break;
      } else if (c === ',' && depth === 1) argStarts.push(j + 1);
      j++;
    }
    if (argStarts.length > 1) {
      const raw = src.slice(argStarts[1], j).trim();
      if (raw) {
        found.push({
          file,
          line: src.slice(0, i).split('\n').length,
          raw,
          resolved: resolveDatastream(raw, src),
        });
      }
    }
    i = start;
  }
  return found;
}

/**
 * Turn the argument text into a datastream name, or null if it is not statically knowable here.
 *
 * Three accepted shapes, all of which occur in this repo:
 *   - a string literal:            logToAxiom(data, 'webhooks')
 *   - a module-scope const:        const STORAGE_LOG = 'app-storage-trpc'; ... logToAxiom(d, STORAGE_LOG)
 *   - a parameter default in a shim: function logToAxiom(data, datastream = 'civitai-prod')
 *
 * An identifier whose const cannot be found resolves to null and FAILS the scan rather than being
 * skipped — an unreadable name is exactly the case this ledger must not wave through.
 */
function resolveDatastream(raw: string, src: string): string | null {
  const literal = raw.match(/^['"`]([^'"`]+)['"`]$/);
  if (literal) return literal[1];

  const paramDefault = raw.match(/=\s*['"`]([^'"`]+)['"`]\s*$/);
  if (paramDefault) return paramDefault[1];

  const ident = raw.match(/^[A-Za-z_$][\w$]*$/);
  if (ident) {
    const decl = new RegExp(
      `\\b(?:const|let|var)\\s+${raw}\\s*(?::[^=]+)?=\\s*['"\`]([^'"\`]+)['"\`]`
    ).exec(src);
    return decl ? decl[1] : null;
  }
  return null;
}

function walk(dir: string, acc: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (CODE_FILE.test(entry.name)) acc.push(full);
  }
}

function collect(): Found[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(ROOT, root), files);
  const found: Found[] = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (TEST_FILE.test(rel)) continue;
    const src = readFileSync(abs, 'utf8');
    if (!src.includes('logToAxiom(')) continue;
    found.push(...secondArgs(rel, blankComments(src)));
  }
  return found;
}

const ALL = collect();
const NAMED = ALL.filter((f) => f.resolved !== null);

describe('Axiom datastream call-site ledger', () => {
  // ================================================================
  // The scan is an instrument; validate it before reading its verdict
  // ================================================================

  it('the scan actually found call sites (a zero here would make every assertion below vacuous)', () => {
    // A positive control on the walker itself: if a refactor moves or renames the call, this test
    // reports it instead of the rest of the file silently passing over an empty set.
    expect(ALL.length).toBeGreaterThan(50);
    expect(NAMED.length).toBeGreaterThan(50);
    expect(new Set(NAMED.map((f) => f.resolved)).size).toBeGreaterThan(5);
  });

  it('resolves the three argument shapes it claims to: literal, module const, parameter default', () => {
    const byName = (n: string) => NAMED.some((f) => f.resolved === n);
    expect(byName('webhooks')).toBe(true); // plain literal
    expect(byName('app-storage-trpc')).toBe(true); // via `const STORAGE_LOG = ...`
    expect(byName('civitai-prod')).toBe(true); // incl. shim parameter defaults
  });

  it('blanks commented-out call sites rather than collecting them', () => {
    // Pins the tokenizer's job with a fixture, not a repo grep — the repo's commented-out call
    // could be deleted tomorrow and this assertion would then be silently vacuous.
    const src = blankComments(
      [
        `const u = 'https://example.test/a';`,
        `// logToAxiom({ a: 1 }, 'commented-out-stream');`,
        `logToAxiom({ b: 2 }, 'live-stream');`,
      ].join('\n')
    );
    const names = secondArgs('fixture.ts', src).map((f) => f.resolved);
    expect(names).toEqual(['live-stream']);
    // ...and the URL's `//` did not eat its own closing quote.
    expect(src).toContain(`'https://example.test/a'`);
  });

  // ================================================================
  // The relationship
  // ================================================================

  it('every datastream a production call site names is either PROVISIONED or ledgered LOKI-ONLY', () => {
    const unaccounted = NAMED.filter(
      (f) => !PROVISIONED_AXIOM_DATASTREAMS.has(f.resolved!) && !(f.resolved! in LOKI_ONLY)
    ).map((f) => `${f.resolved} at ${f.file}:${f.line}`);

    expect(unaccounted).toEqual([]);
  });

  it('the LOKI-ONLY ledger matches the source exactly — fails when it GROWS or SHRINKS', () => {
    const observed = new Set(
      NAMED.map((f) => f.resolved!).filter((n) => !PROVISIONED_AXIOM_DATASTREAMS.has(n))
    );

    expect([...observed].sort()).toEqual(Object.keys(LOKI_ONLY).sort());
  });

  it('no ledgered LOKI-ONLY name is also claimed as provisioned', () => {
    const both = Object.keys(LOKI_ONLY).filter((n) => PROVISIONED_AXIOM_DATASTREAMS.has(n));
    expect(both).toEqual([]);
  });

  it('every ledger entry carries a real reason, not a placeholder', () => {
    for (const [name, why] of Object.entries(LOKI_ONLY)) {
      expect(why.length, `${name} needs a reason`).toBeGreaterThan(30);
    }
  });

  it('a datastream argument this scan cannot resolve is only allowed in a declared forwarding file', () => {
    const unreadable = ALL.filter((f) => f.resolved === null && !FORWARDING_FILES.has(f.file)).map(
      (f) => `${f.file}:${f.line} -> ${f.raw.replace(/\s+/g, ' ').slice(0, 60)}`
    );

    // A dynamic datastream would be a name no static check can audit. If one is genuinely needed,
    // widen FORWARDING_FILES deliberately — do not let it arrive by accident.
    expect(unreadable).toEqual([]);
  });
});
