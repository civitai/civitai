#!/usr/bin/env node
/**
 * Blocking guard: no API route may declare a request-body `sizeLimit` LARGER than the
 * body Next will actually hand it.
 *
 * WHY THIS EXISTS. Next caps an incoming request body at
 * `experimental.proxyClientMaxBodySize` (default 10MB) and then simply ENDS the stream.
 * The route is not told. A handler reading that stream sees a clean end-of-body, not an
 * error — so a route declaring `sizeLimit: '72mb'` does not get 72MB and does not get a
 * failure either. It gets a silent truncation at 10MB.
 *
 * That is not hypothetical. `src/pages/api/v1/image-upload/relay.ts` shipped with a 50MB
 * cap that was UNREACHABLE for exactly this reason, and before the guards added there a
 * valid 14,523,378-byte PNG was stored as a 10,485,209-byte object with no `IEND`
 * terminator while the route answered `200 {"id": …}` — a corrupt image reported to the
 * caller as a successful upload. Measured on a deployed preview (Next 16.3.1),
 * reproduced both through the ingress and from inside the container against the app port,
 * so it is the framework and not a proxy in front:
 *
 *     sent 10,485,760 -> delivered 10,485,760   intact
 *     sent 12,000,000 -> delivered 10,438,916   TRUNCATED
 *     sent 55,000,000 -> delivered 10,479,830   TRUNCATED
 *
 * WHAT IT ASSERTS, AND WHY THAT IS THE RIGHT INVARIANT. It pins a RELATIONSHIP —
 * declared limit <= deliverable limit — not a value. Either side may move freely as long
 * as they stay consistent: raise `proxyClientMaxBodySize` and the routes are fine; lower
 * a route's `sizeLimit` and it is fine. Only the incoherent combination fails, which is
 * the only combination that silently corrupts data. A guard on a fixed number would need
 * re-pinning on every Next bump and would say nothing about the pairing.
 *
 * DELTA, NOT ABSOLUTE. Four routes already declare more than the framework delivers (see
 * the baseline). Failing on those would make this permanently red, and a permanently-red
 * gate is worse than no gate — it trains everyone to click through. So a baselined
 * violation WARNS and a new-or-worsened one FAILS. Shrinking a declared limit, or
 * removing the route, is always allowed and the baseline may be regenerated down.
 *
 *   node scripts/ci/body-size-limit-gate.mjs                  # check (CI)
 *   node scripts/ci/body-size-limit-gate.mjs --write-baseline # re-record current state
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const API_DIR = join(REPO_ROOT, 'src', 'pages', 'api');
const NEXT_CONFIG = join(REPO_ROOT, 'next.config.mjs');
const BASELINE = join(import.meta.dirname, 'body-size-limit-baseline.json');

/**
 * Next's own default for `experimental.proxyClientMaxBodySize`, in bytes.
 *
 * 🔴 Hardcoded ON PURPOSE, and pinned against the installed Next by
 * `scripts/__tests__/body-size-limit-gate.test.ts`. Reading it out of Next's internals at
 * runtime would make this gate depend on the shape of a private build artifact; asserting
 * it in a test instead means a Next upgrade that changes the default fails loudly in one
 * named place rather than silently widening what this gate permits.
 */
export const NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_SIZE = 10 * 1024 * 1024;

/** Parse a Next `SizeLimit` (`'72mb'`, `'500kb'`, `1048576`) into bytes. */
export function parseSizeLimit(raw) {
  if (typeof raw === 'number') return raw;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(String(raw));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'b').toLowerCase();
  return Math.round(n * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit]);
}

/**
 * The largest body Next will deliver to a route.
 *
 * Read by regex rather than by importing `next.config.mjs`: that module pulls in plugins
 * and has side effects, and this gate is meant to run in ~50ms in a blocking job with no
 * module graph. `proxyClientMaxBodySize` wins when both are present, mirroring Next's own
 * precedence (`middlewareClientMaxBodySize` is deprecated in favour of it).
 */
export function effectiveBodyLimit(configSource) {
  for (const key of ['proxyClientMaxBodySize', 'middlewareClientMaxBodySize']) {
    const m = new RegExp(`${key}\\s*:\\s*(?:'([^']+)'|"([^"]+)"|([\\d_]+))`).exec(configSource);
    if (m) {
      const v = m[1] ?? m[2] ?? m[3].replace(/_/g, '');
      const bytes = parseSizeLimit(v);
      if (bytes !== null) return { bytes, source: key };
    }
  }
  return { bytes: NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_SIZE, source: 'next default' };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.[cm]?tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/** Every `sizeLimit: '<v>'` declared under the API routes, as { file, declared, bytes }. */
export function collectDeclaredLimits(apiDir, repoRoot) {
  const found = [];
  for (const file of walk(apiDir)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/sizeLimit\s*:\s*(?:'([^']+)'|"([^"]+)"|([\d_]+))/g)) {
      const declared = m[1] ?? m[2] ?? m[3].replace(/_/g, '');
      const bytes = parseSizeLimit(declared);
      if (bytes === null) continue;
      found.push({ file: relative(repoRoot, file).split('\\').join('/'), declared, bytes });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.bytes - b.bytes);
}

function main() {
  const write = process.argv.includes('--write-baseline');
  const limit = effectiveBodyLimit(readFileSync(NEXT_CONFIG, 'utf8'));
  const declared = collectDeclaredLimits(API_DIR, REPO_ROOT);
  const over = declared.filter((d) => d.bytes > limit.bytes);

  if (write) {
    writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          _comment:
            'Routes declaring a bodyParser sizeLimit LARGER than Next will deliver, so the declared value is not what the route receives — Next truncates and the route is not told. Entries may shrink or disappear freely; adding one, or raising a byte count, fails the gate and is a deliberate act visible in review. Regenerate with: node scripts/ci/body-size-limit-gate.mjs --write-baseline',
          effectiveLimitBytes: limit.bytes,
          effectiveLimitSource: limit.source,
          routes: Object.fromEntries(over.map((d) => [d.file, d.bytes])),
        },
        null,
        2
      )}\n`
    );
    console.log(`wrote baseline: ${over.length} route(s) over the ${limit.bytes}-byte limit`);
    return 0;
  }

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const known = baseline.routes ?? {};
  const regressions = over.filter((d) => !(d.file in known) || d.bytes > known[d.file]);

  console.log(
    `body-size-limit-gate: effective request-body limit ${limit.bytes} bytes (${limit.source}); ` +
      `${declared.length} declared sizeLimit(s) scanned, ${over.length} over, ${regressions.length} NEW`
  );

  // A positive control on the scanner itself: if it matched nothing at all, it is far
  // more likely the pattern or the path is wrong than that the repo declares no limits.
  if (declared.length === 0) {
    console.error(
      `FAIL: scanned ${API_DIR} and found NO sizeLimit declarations at all. That is a broken\n` +
        `scan, not a clean repo — every known revision of this tree declares several.`
    );
    return 1;
  }

  for (const d of over.filter((x) => !regressions.includes(x))) {
    console.warn(
      `  warn (baselined): ${d.file} declares ${d.declared} — truncated at ${limit.bytes}`
    );
  }

  if (regressions.length === 0) return 0;

  console.error('\nFAIL: a route declares a body limit larger than Next will deliver.\n');
  for (const d of regressions) {
    console.error(
      `  ${d.file}\n    declares ${d.declared} (${d.bytes} bytes) but Next delivers at most ${limit.bytes}.`
    );
  }
  console.error(
    `\nNext truncates the body at ${limit.bytes} bytes and ENDS THE STREAM — the route is not\n` +
      `told, so it reads a short body as a complete one. Either:\n` +
      `  - lower the route's sizeLimit to <= ${limit.bytes}, or\n` +
      `  - raise \`experimental.proxyClientMaxBodySize\` in next.config.mjs (repo-wide: it\n` +
      `    widens the body EVERY route may receive, so weigh the memory cost), or\n` +
      `  - if the truncation is genuinely acceptable for this route, re-record it:\n` +
      `      node scripts/ci/body-size-limit-gate.mjs --write-baseline\n`
  );
  return 1;
}

// Run only when invoked directly, so the test can import the pure helpers above without
// the gate executing (and exiting the test process) on import. Compared as resolved file
// URLs: a suffix match on the basename would also fire for any same-named script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
