// DARK PROBE: would caching external prompt-moderation verdicts actually pay?
//
// WHY this exists. `extModeration.moderatePrompt` is an outbound HTTPS call that runs inline and
// serially on the generation submission path, and it is expensive in WALL TIME: measured in
// production it is ~200 ms per call at p50 ~188 ms, and it accounts for roughly 78-88% of the
// app-side (non-orchestrator-submit) time of `orchestrator.generateFromGraph`.
//
// Three ways to make that cheaper were tested against production measurements and ALL THREE ARE
// DEAD, which is what makes this probe the remaining question rather than one option among many:
//   1. Tune the tail / the abort deadline — the distribution is a FLOOR, not a tail. Zero calls
//      land under 50 ms and 0.46% under 100 ms, so clamping the slow 1.18% is worth single-digit
//      milliseconds of the mean.
//   2. Reuse the connection — the call does pay a fresh TCP+TLS handshake on most invocations
//      (call spacing per process far exceeds undici's 4 s default keep-alive, and nothing in this
//      app configures a dispatcher), but the classifier answers from a nearby edge, so the whole
//      handshake measures ~7-24 ms. Not the lever it looks like.
//   3. Overlap it with the workflow submit — impossible by construction. The audit is a
//      FAIL-CLOSED gate: a flagged prompt throws and must never reach `submitWorkflow`.
// What is left is the classifier's own inference time, and the only way to avoid paying it is to
// NOT MAKE THE CALL. That is worth building only if prompts actually repeat — and nobody knows
// whether they do. This module measures exactly that, and nothing else.
//
// 🔴 IT IS A MEASUREMENT, NOT A CACHE, AND IT MUST NEVER BECOME ONE BY ACCIDENT. No caller reads a
// verdict back from here; `moderatePrompt` issues its request every single time regardless of what
// this reports. Changing that is a moderation-policy decision (a stale verdict is a trust-and-safety
// question, not a performance one) and must be its own change with its own review.
import { createHash } from 'node:crypto';

import { registerCounterWithLabels } from '@civitai/telemetry/client';
import { env } from '~/env/server';
import {
  clampExternalModerationSource,
  type ExternalModerationSource,
} from '~/server/prom/external-moderation.metrics';

/**
 * The windows the probe simulates, as (label, seconds) pairs.
 *
 * 🔴 TWO WINDOWS, NOT ONE, AND THAT IS THE POINT. A single hit rate is one number with no shape:
 * it cannot distinguish "users re-roll the same prompt within minutes" (a tiny TTL captures nearly
 * all of the value, and a small cache is enough) from "the same prompts recur all day across
 * different users" (the value keeps climbing with TTL, and the cache has to be big). Those imply
 * completely different builds. Measuring at a boundary AND a middle is what makes the answer a
 * curve instead of an anecdote.
 *
 * `5m` and `1h` are 12x apart deliberately — close enough that both are cheap, far enough that a
 * flat reading between them is real evidence of saturation rather than measurement noise.
 */
const PROBE_WINDOWS = [
  { label: '5m', seconds: 300 },
  { label: '1h', seconds: 3600 },
] as const;

type ProbeWindowLabel = (typeof PROBE_WINDOWS)[number]['label'];

/**
 * The deployment namespace the probe writes under, or `null` when it is not armed.
 *
 * 🔴 ARMING AND NAMESPACING ARE ONE ACTION. `EXTERNAL_MODERATION_CACHE_PROBE` is a LABEL, not a
 * boolean: several civitai-web deployments share one sysRedis, and sys keys — unlike cache keys —
 * carry no environment segment (`cache-key-prefix.ts`: "This is CACHE-ONLY"). Two armed
 * deployments writing one probe keyspace would each score HITS on the other's prompts, biasing the
 * result toward "caching pays". Requiring a namespace to arm at all is what makes that unforgettable
 * rather than a note in a doc.
 *
 * A value that is not a known deployment label returns `null` (i.e. OFF) rather than being
 * sanitised or accepted: a typo then yields NO SERIES, which the metric's help text already tells
 * the reader means "not armed", instead of quietly opening a second keyspace that looks armed and
 * measures a fiction. It is logged once so the operator can tell the two apart.
 *
 * 🔴 A CLOSED ALLOWLIST, NOT A CHARSET PLUS A DENYLIST — and the denylist it replaces is why.
 * The first version of this guard accepted any `/^[a-z0-9][a-z0-9-]{0,31}$/` and rejected ten
 * on/off words. That is a guard SPELLED rather than STRUCTURAL: it defends a class by listing its
 * members, so every spelling nobody thought of walks straight through. Audit round 3 enumerated
 * the survivors — `y`, `n`, `none`, `null`, `undefined`, `nil`, `disable`, `enable`, `2` — and
 * `y`/`n` are not exotic: zod's own `stringbool` treats them as boolean spellings, so an operator
 * carrying that habit writes `=n`, the probe ARMS under a namespace called `n`, and two
 * deployments "disabled" that way share `…:n:…` and score hits on each other's prompts. That is
 * the exact collision this namespace exists to prevent, arriving at the moment the operator
 * believes the probe is off.
 *
 * An allowlist cannot be walked by a spelling nobody thought of. The cost is that arming a NEW
 * deployment needs a one-line code change — acceptable, and arguably correct, for a temporary
 * measurement instrument whose deployment set is known, small, and expected to shrink to zero when
 * the probe is removed.
 *
 * 🔴 THE ONLY MEMBER IS `prod`, AND BOTH OMISSIONS ARE LOAD-BEARING. The list held four members
 * at audit round 4; rounds 4 and 5 removed three of them, each for a measured reason:
 *
 *   · `preview` is not a deployment, it is a CLASS — ~10 concurrent `civitai-pr-*` namespaces run
 *     this code and share one `civitai-pr-sysredis`, so arming that one word arms all of them into
 *     a single keyspace and they score mutual hits across unrelated PRs.
 *   · `next` LOOKS like a single deployment and is not, for the same reason one level up: the
 *     PR-preview Tekton task copies civitai-next's `civitai-cfg` ConfigMap WHOLESALE into every
 *     `civitai-pr-<N>` namespace, overriding only an explicit key list this variable is not on.
 *     So arming `next` silently arms every open PR's preview too, onto that same shared sysRedis.
 *     Removing `preview` alone did not close the hazard; it moved it.
 *   · `next-stage` is a genuine single deployment, and arming it would still be useless: it has
 *     NO ServiceMonitor or PodMonitor, so nothing scrapes it. Measured — `civitai-next` and
 *     `civitai-next-stage` have zero monitors between them, and the probe's population twin
 *     `civitai_app_external_moderation_duration_seconds_count` exists in exactly one namespace,
 *     `civitai-dp-prod`. An operator arming a non-scraped deployment sees no series at all, which
 *     this metric's own help text defines as "not armed" — the two states the whole arming design
 *     exists to keep apart.
 *
 * 🔴 SO BEFORE ADDING A MEMBER, CHECK BOTH: that it names ONE running population rather than a
 * template other namespaces inherit, and that something actually scrapes it. A member that fails
 * either test makes this guard assert an invariant it does not enforce, which is worse than no
 * guard because the guard is what stops anyone looking.
 *
 * Exported so a test can assert the membership as a LEDGER — failing when the set grows OR shrinks,
 * not merely when a known member disappears.
 *
 * 🔴 A FROZEN ARRAY, NOT A `ReadonlySet`. `ReadonlySet<string>` is a COMPILE-TIME type and is erased
 * at runtime, so `(PROBE_NAMESPACES as Set<string>).add('preview')` from any importer would arm an
 * arbitrary namespace against the same object `probeNamespace` reads. `Object.freeze` on an array is
 * enforced by the runtime.
 *
 * 🔴 AND IT IS ONE OBJECT, DELIBERATELY — the ASSERTED object and the CONSULTED object must be the
 * same one. A previous revision kept a private `Set` beside this array for O(1) lookup, and audit
 * round 7 measured what that cost: growing the SET alone, leaving the array untouched, armed a new
 * namespace while the ledger test kept happily asserting `['prod']` — green 22/22. The ledger's
 * whole claim is that growth fails, and a second copy is exactly how that claim goes false. With a
 * membership this small `.includes` is not measurably slower than `.has`, and it cannot drift.
 */
export const PROBE_NAMESPACES: readonly string[] = Object.freeze(['prod']);

let warnedNamespace: string | null = null;

function probeNamespace(): string | null {
  const raw = env.EXTERNAL_MODERATION_CACHE_PROBE?.trim() ?? '';
  // Empty is the DELIBERATELY-unarmed case — every deployment today — so it returns before the
  // diagnostic below. Shipping inert has to mean shipping silent: without this line the probe is
  // still off (an empty string is not in the allowlist either), but every unarmed pod logs a
  // misconfiguration error it has done nothing to deserve.
  if (raw === '') return null;
  if (PROBE_NAMESPACES.includes(raw)) return raw;

  // Warn ONCE per distinct bad value: this runs on the generation hot path, and a per-call log on a
  // misconfigured deployment would be its own incident. `console.error` rather than a throw for the
  // reason cache-key-prefix.ts gives for the same choice — a namespace mistake must not be able to
  // take a deployment down.
  //
  // ⚠️ NOT because the previous spelling "failed boot loudly on garbage" — that claim was in this
  // comment for one commit and it was FALSE. `zc.booleanString` is
  // `z.preprocess((v) => v === true || v === 'true', z.boolean())`, and that preprocess maps EVERY
  // input to a boolean, so the inner schema can never fail: executed against the installed zod,
  // `'off'`, `'garbage'`, `'$$$'` and `''` all parse successfully to `false`. The old contract
  // swallowed garbage silently too. The log is worth having on its own merits — it is the only way
  // to tell "armed, no repeats" from "my value was rejected" — not because it restores a guard
  // that never existed.
  if (warnedNamespace !== raw) {
    warnedNamespace = raw;
    console.error(
      `[moderation-cache-probe] EXTERNAL_MODERATION_CACHE_PROBE=${JSON.stringify(raw)} is not a ` +
        `known deployment namespace (${PROBE_NAMESPACES.join(', ')}). The probe is DISABLED. ` +
        `Set it to one of those to arm it, or leave it empty to disable it deliberately.`
    );
  }
  return null;
}

/**
 * `miss` = this exact prepared prompt had not been seen inside the window (a real cache would have
 * called the classifier). `hit` = it had (a real cache would have skipped the call). `error` = the
 * probe itself failed — Redis unreachable, a command deadline, anything.
 *
 * 🔴 `error` IS A SEPARATE RESULT SO THE HIT RATE CANNOT SILENTLY DEFLATE. Divide by `hit + miss`,
 * NEVER by the total across all three: a Redis outage would otherwise read as "prompts stopped
 * repeating", which is the reassuring direction and therefore the dangerous one.
 */
type ProbeResult = 'hit' | 'miss' | 'error';

const probeCounter = registerCounterWithLabels({
  name: 'external_moderation_cache_probe_total',
  help:
    'DARK PROBE (measurement only, changes no behaviour): counts whether the exact string sent to ' +
    'the external prompt classifier had already been seen inside a window, to size whether caching ' +
    'moderation verdicts would pay. Labeled by source (same population split as ' +
    'external_moderation_duration_seconds), window (5m|1h) and result (hit|miss|error). A hit means ' +
    'a real cache with that TTL WOULD have skipped the call — the classifier was still called. ' +
    'COMPUTE THE HIT RATE AS sum by (window) (rate(...{result="hit"}[..])) / sum by (window) ' +
    '(rate(...{result=~"hit|miss"}[..])). BOTH halves matter: dividing over the TOTAL folds in ' +
    'error, so a Redis outage reads as "prompts stopped repeating"; and omitting `by (window)` ' +
    'averages the 5m and 1h series into one number, which is exactly the shape the two windows ' +
    'exist to reveal. 🔴 IGNORE THE FIRST FULL WINDOW AFTER ARMING — the probe keyspace starts ' +
    'empty, so every observation is necessarily a miss until it has been running longer than the ' +
    'window it is measuring, and a hit rate read too early is biased toward zero by construction. ' +
    '🔴 THE RESULT IS SCOPED, NOT ABSOLUTE — it differs from a real cache on TWO independent axes ' +
    '(it coalesces concurrent duplicates; its TTL never extends on a hit), so the bound depends on ' +
    'BOTH. vs a fixed-TTL NON-COALESCING cache: an UPPER bound. vs a sliding-TTL COALESCING cache: ' +
    'a LOWER bound. vs a sliding-TTL NON-COALESCING cache — the ordinary design, since singleflight ' +
    'is a feature you must build — the two effects OPPOSE and NO bound is established; treat the ' +
    'number as an estimate. Name both axes of the design you are comparing against before quoting ' +
    'a direction — see the SET NX note in the source. ' +
    'Armed per deployment via EXTERNAL_MODERATION_CACHE_PROBE, whose value is the key namespace; ' +
    'unarmed there are no series at all, which is what makes the arming instant readable.',
  labelNames: ['source', 'window', 'result'] as const,
});

function record(
  source: ExternalModerationSource,
  window: ProbeWindowLabel,
  result: ProbeResult
): void {
  try {
    probeCounter.inc({ source, window, result });
  } catch {
    // Observability must never break the moderation path. Swallow any prom-client error.
  }
}

/**
 * Hash of the exact string handed to the classifier.
 *
 * Truncated to 32 hex chars (128 bits) because the only operation performed on it is equality
 * inside one bounded window — collisions at 128 bits are not a practical concern at these volumes,
 * and the shorter key keeps the probe keyspace small.
 *
 * 🔴 THE PROMPT ITSELF IS NEVER STORED, LOGGED OR LABELLED. Only this digest reaches Redis, and
 * nothing user-controlled reaches a metric label — a prompt on a label would be an unbounded
 * cardinality incident on a hot path, on top of being user content in an observability system.
 */
function digestPrompt(preparedPrompt: string): string {
  return createHash('sha256').update(preparedPrompt).digest('hex').slice(0, 32);
}

/**
 * Fire-and-forget. Records, for each window, whether `preparedPrompt` had been seen before.
 *
 * 🔴 DELIBERATELY NOT AWAITED BY THE CALLER, AND THAT IS LOAD-BEARING TWICE OVER. First, this runs
 * on the generation submission path: awaiting a Redis round trip here would add latency to the very
 * request whose latency is under investigation, so the instrument would perturb its own subject.
 * Second, it makes the probe unable to fail the generation — there is no path from a Redis problem
 * to a user-visible error, because nothing downstream is waiting on this promise.
 *
 * The Redis client is imported LAZILY, inside the async body. `moderation.ts` is imported by a cron
 * job and keeps a deliberately light import graph; a static import here would pull the whole Redis
 * client into it for a feature that is off by default.
 */
export function probeModerationCacheRepeat(
  source: ExternalModerationSource,
  preparedPrompt: string
): void {
  const namespace = probeNamespace();
  if (namespace === null) return;
  // 🔴 CLAMP HERE, NOT ONLY AT THE CALLER. `moderatePrompt` already clamps and passes the clamped
  // value, so this looks redundant and an audit mutant that removed it SURVIVED a green 14-case
  // suite. It is not redundant: this function is EXPORTED, so its `source` is reachable from a
  // future direct caller and from the test tree, which `tsconfig.json` excludes — and an unbounded
  // string on a hot-path prom label is a cardinality incident that arrives with no error anywhere.
  // The clamp is now exercised directly by a test that calls this function rather than
  // `moderatePrompt`; without that test the guard reads as covered while being untested.
  void runProbe(clampExternalModerationSource(source), preparedPrompt, namespace).catch(() => {
    // `runProbe` already records `error` per window; this only guards a throw before that point
    // (e.g. the dynamic import itself failing), which has no window to attribute.
  });
}

/**
 * The probe's Redis key: `<prefix>:<namespace>:<window>:<digest>`.
 *
 * 🔴 THIS EXISTS AS A SEPARATE, EXPORTED FUNCTION FOR ONE REASON: to make the namespace derivation
 * TESTABLE. It is not an abstraction anyone asked for, and inlining it would read better.
 *
 * Audit round 6 measured the problem it solves. Once the allowlist narrowed to a single member,
 * `namespace` is always `'prod'` at runtime, so a mutant replacing `${namespace}` with the literal
 * `prod` became INDISTINGUISHABLE from the real thing and SURVIVED a green 21-case suite — the
 * same mutant that was killed by two cases one commit earlier. The key-shape test cannot see it,
 * because with one member the shape is identical either way. So the coverage for the segment that
 * exists to keep two deployments apart quietly went to zero at exactly the moment two rounds of
 * work had gone into strengthening it.
 *
 * A pure function takes the namespace as an ARGUMENT, so a test can pass two different values
 * without config being able to produce them. That restores the kill.
 *
 * ⚠️ AT THE FUNCTION ONLY — THE CALL SITE REMAINS UNCOVERED, AND THIS IS THE HONEST LIMIT. Audit
 * round 7 measured it: hardcoding the third argument at the call site in `runProbe` (rather than
 * inside this function) still leaves the suite green. With one allowlist member, `namespace` is
 * always `'prod'` on every path config can reach, so no test driven through the public surface can
 * distinguish a hardcoded argument from the derived one. Closing it would need a test-only
 * injectable namespace resolver — more machinery than a temporary probe warrants — so it is
 * recorded here instead of being left to read as closed. If a second member is ever added, that
 * ALSO re-opens this: add a two-namespace behavioural case at the same time.
 */
export function buildProbeKey<P extends string>(
  prefix: P,
  namespace: string,
  window: string,
  digest: string
): `${P}:${string}` {
  // 🔴 GENERIC IN THE PREFIX, and not for elegance. `sysRedis.set` takes a key from a closed
  // template-literal union derived from REDIS_SYS_KEYS, so a return type of `${string}:${string}`
  // widens the key out of that union and the call stops compiling. Threading `P` through keeps the
  // prefix literal, so the result is still `generation:moderation-cache-probe:${string}` and the
  // typed-key guarantee survives the extraction. (Caught by `pnpm typecheck` the moment this
  // function was introduced — the first version returned the widened type.)
  return `${prefix}:${namespace}:${window}:${digest}`;
}

async function runProbe(
  source: ExternalModerationSource,
  preparedPrompt: string,
  namespace: string
): Promise<void> {
  const digest = digestPrompt(preparedPrompt);
  const { sysRedis, REDIS_SYS_KEYS } = await import('~/server/redis/client');

  await Promise.all(
    PROBE_WINDOWS.map(async ({ label, seconds }) => {
      try {
        // SET NX EX is the whole measurement, in one atomic round trip: it returns a truthy reply
        // when the key did NOT exist (a miss, and the key is now claimed for `seconds`) and null
        // when it did (a hit). One round trip rather than GET-then-SET keeps the two windows cheap
        // and the observation self-consistent — but do NOT read that atomicity as accuracy:
        //
        // 🔴 BUT NX ALSO MAKES THIS AN UPPER BOUND, NOT A FLOOR — do not read the atomicity as pure
        // fidelity. `SET NX` claims the slot the moment the request STARTS, whereas a plain
        // read-through cache cannot store a verdict until the classifier ANSWERS ~200 ms later. So
        // for two identical prompts submitted 50 ms apart (a re-roll double-click, or a trending
        // prompt) this scores miss+hit while a non-coalescing cache would score miss+miss. What it
        // faithfully simulates is a cache with request COALESCING (singleflight); against one
        // without, the number here is optimistic.
        //
        // The TTL is separately FIXED FROM FIRST WRITE, not sliding — NX means a hit does not
        // extend it — and that pushes the OTHER way, understating what a sliding-TTL cache would
        // achieve.
        //
        // 🔴 SO "UPPER BOUND" IS A CLAIM ABOUT ONE COMPARISON, NOT ABOUT REALITY IN GENERAL, and an
        // earlier revision of this comment got that wrong: it named both biases, said they "do not
        // cancel to anything knowable", and then concluded "upper bound" anyway — a conclusion its
        // own premise withdraws. State the scope instead:
        //   · vs a fixed-TTL, NON-COALESCING cache — this OVERSTATES (upper bound).
        //   · vs a sliding-TTL, COALESCING cache — this UNDERSTATES (lower bound).
        //   · vs a sliding-TTL, NON-COALESCING cache — INDETERMINATE. The two effects oppose and
        //     neither dominates, so no bound holds in either direction.
        // ⚠️ That third line is the one an earlier revision got wrong: it said "vs a SLIDING-TTL
        // cache — that design can only score higher", pinning only the TTL axis. A sliding-TTL
        // cache that is not ALSO coalescing still never repays this probe's coalescing bonus, and
        // singleflight is an extra feature you must build, so the ordinary sliding-TTL design is
        // exactly the indeterminate case. Name BOTH axes before quoting a direction.
        //
        // The namespace segment keeps two armed deployments off each other's keyspace; see
        // `probeNamespace`. Built through `buildProbeKey` rather than inline SOLELY so a test can
        // drive it with two different namespaces — see that function's note.
        const key = buildProbeKey(
          REDIS_SYS_KEYS.GENERATION.MODERATION_CACHE_PROBE,
          namespace,
          label,
          digest
        );
        const claimed = await sysRedis.set(key, '1', { NX: true, EX: seconds });
        record(source, label, claimed ? 'miss' : 'hit');
      } catch {
        record(source, label, 'error');
      }
    })
  );
}
