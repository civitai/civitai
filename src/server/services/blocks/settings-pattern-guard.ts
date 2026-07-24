/**
 * SERVER-ONLY. Submission-time ReDoS + input-bound gate for app-block manifest
 * `settings` field patterns.
 *
 * ⚠️ NEVER import this from a client-bundled module. It pulls in `recheck`, an
 * accurate ReDoS analyzer (~300KB, ships native/JVM backends). The manifest
 * validator reaches it via a dynamic `import()` from
 * `BlockManifestValidator.validateSubmission` (server paths only: the git-push
 * webhook, the developer manifest API, `blocks.updateManifest`, and the
 * publish-request approve flow), so `recheck` never lands in the client bundle.
 *
 * Why `recheck` (not `safe-regex`): `safe-regex` is a coarse star-height
 * heuristic that FALSE-POSITIVES on common linear patterns — it rejects the
 * canonical slug `^[a-z0-9]+(-[a-z0-9]+)*$`, decimals `^\d{1,4}(\.\d{1,2})?$`,
 * and snake_case `^[a-z0-9]+(_[a-z0-9]+)*$`, none of which are ReDoS-prone.
 * `recheck` does a real analysis (automaton + fuzzing) and classifies a regex
 * as safe / vulnerable (exponential OR polynomial) / unknown.
 */

// Force recheck's portable, in-process pure-JS engine. Its default `auto`
// backend prefers a prebuilt native binary (or a JVM jar) spawned over a
// worker thread; that binary is a generic dynamically-linked ELF that CANNOT
// run on some hosts (e.g. NixOS / hardened CI) and there HANGS the analysis.
// The `pure` (Scala.js) engine runs in-process, is deterministic everywhere,
// and is plenty fast for this path — manifest submission is not a hot request.
// recheck reads these at call time, so setting them here (before first use) is
// sufficient; we don't clobber an explicit operator override.
process.env.RECHECK_BACKEND = process.env.RECHECK_BACKEND || 'pure';
process.env.RECHECK_SYNC_BACKEND = process.env.RECHECK_SYNC_BACKEND || 'pure';

import { check } from 'recheck';
import { MAX_PATTERNED_INPUT_LEN } from '~/server/schema/blocks/manifest-settings.meta.schema';

// Overall per-pattern analysis ceiling. Normal patterns resolve in tens of ms;
// this only bounds a pathological analysis. On timeout recheck returns status
// `unknown` (treated as "not proven vulnerable" — accepted), and the eval-site
// input cap (MAX_PATTERNED_INPUT_LEN) still bounds that pattern's runtime cost.
const RECHECK_TIMEOUT_MS = 5000;

/**
 * Returns true iff `source` is NOT provably safe — i.e. recheck classifies it as
 * `vulnerable` (catastrophic backtracking, exponential OR super-linear) OR as
 * `unknown` (recheck errored / timed out and could not analyze it).
 *
 * 🔴 FAIL-CLOSED on `unknown`: a pattern recheck cannot analyze within the
 * timeout is REJECTED, not accepted. Accepting it would be a bypass — a pattern
 * crafted to stall recheck's own analysis (status `unknown`) would otherwise sail
 * through the gate and then run against viewer input at eval time, and an
 * exponential pattern freezes even on the ≤MAX_PATTERNED_INPUT_LEN-bounded input.
 * Only a definitive `safe` verdict passes.
 */
export async function isPatternRedosVulnerable(source: string): Promise<boolean> {
  const diagnostics = await check(source, '', { timeout: RECHECK_TIMEOUT_MS });
  return diagnostics.status !== 'safe';
}

/**
 * Collects submission-time errors for every string-setting `pattern` declared in
 * a raw manifest `settings` block:
 *   - the pattern must compile,
 *   - a patterned field MUST declare `max_length <= MAX_PATTERNED_INPUT_LEN`
 *     (bounds the viewer input the pattern is ever `.test()`ed against),
 *   - the pattern must not be ReDoS-vulnerable (recheck).
 *
 * Operates on the RAW manifest shape (not zod-parsed) so it is robust even if
 * some other field is malformed. Non-object / absent `settings` ⇒ no errors
 * (shape validation is a separate concern). Returns [] when everything passes.
 */
export async function collectSettingsPatternErrors(settings: unknown): Promise<string[]> {
  const errors: string[] = [];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return errors;

  for (const [key, def] of Object.entries(settings as Record<string, unknown>)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
    const field = def as { pattern?: unknown; max_length?: unknown };
    if (typeof field.pattern !== 'string') continue;

    // A patterned field must bound the input its regex is run against.
    if (typeof field.max_length !== 'number') {
      errors.push(
        `settings.${key}: a field declaring "pattern" must also declare "max_length" (<= ${MAX_PATTERNED_INPUT_LEN})`
      );
    } else if (field.max_length > MAX_PATTERNED_INPUT_LEN) {
      errors.push(
        `settings.${key}: max_length must be <= ${MAX_PATTERNED_INPUT_LEN} when a pattern is declared`
      );
    }

    // Must compile before it can be analyzed or ever executed at runtime.
    let compiles = true;
    try {
      new RegExp(field.pattern);
    } catch {
      compiles = false;
      errors.push(`settings.${key}: pattern is not a valid RegExp source`);
    }

    // Accurate ReDoS analysis. A pattern can COMPILE and still catastrophically
    // backtrack (e.g. (a+)+$, (x+x+)+y, ([a-zA-Z]+)*$); bounding the input can't
    // save an exponential blowup, so it must be rejected at submission.
    if (compiles && (await isPatternRedosVulnerable(field.pattern))) {
      errors.push(
        `settings.${key}: pattern is vulnerable to ReDoS (catastrophic backtracking) — ` +
          'remove nested or overlapping unbounded quantifiers (e.g. "(a+)+") or simplify the expression'
      );
    }
  }
  return errors;
}
