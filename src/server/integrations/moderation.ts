import { env } from '~/env/server';
import { probeModerationCacheRepeat } from '~/server/integrations/moderation-cache-probe';
import {
  clampExternalModerationSource,
  isAbortDeadlineError,
  observeExternalModeration,
  recordExternalModerationSkipped,
  type ExternalModerationSource,
} from '~/server/prom/external-moderation.metrics';
import { setActiveSpanAttributes, withSpan } from '~/server/utils/otel-helpers';

const falsePositiveTriggers = Object.entries({
  '\\d*girl': 'woman',
  '\\d*boy': 'man',
  '\\d*girls': 'women',
  '\\d*boys': 'men',
  'school uniform': 'uniform',
  'breasts?': 'chest',
}).map(([k, v]) => ({ regex: new RegExp(`\\b${k}\\b`, 'gi'), replacement: v }));
function removeFalsePositiveTriggers(prompt: string) {
  for (const trigger of falsePositiveTriggers) {
    prompt = prompt.replace(trigger.regex, trigger.replacement);
  }
  return prompt;
}

/**
 * Call the external prompt classifier.
 *
 * `source` is OBSERVABILITY ONLY — it selects the `source` label on
 * `civitai_app_external_moderation_duration_seconds` and changes nothing about the request, the
 * deadline or the verdict. It is optional and defaults to `other` so an undeclared caller can never
 * inflate the `generate` population; see `external-moderation.metrics.ts` for what each value means.
 */
async function moderatePrompt(
  prompt: string,
  source: ExternalModerationSource = 'other'
): Promise<{ flagged: false; categories: string[] }> {
  // Clamp once, here, so every instrument below shares one bounded value.
  //
  // 🔴 NOT because callers build these options by spread — none do, and that rationale was fiction;
  // it is corrected in full at `~/server/prom/external-moderation.metrics`. The real reason is that
  // `moderatePrompt` is EXPORTED, so this argument is reachable from callers `tsc` does not
  // constrain: a value already widened to `string` (a cast, a `JSON.parse`), and the test tree,
  // which `tsconfig.json` excludes. An unbounded label value on a hot-path histogram is a
  // cardinality incident — prom-client retains every distinct label set in the Node heap until the
  // metric is reset, independently in every scraped pod — and it arrives with a green suite and no
  // error anywhere.
  const metricSource = clampExternalModerationSource(source);

  // Read once, into locals, so the guard below narrows them for the fetch. The fetch now runs inside
  // a callback, and TS cannot carry a narrowing of a mutable object property across a closure
  // boundary — the values themselves are identical to what the straight-line version read.
  const endpoint = env.EXTERNAL_MODERATION_ENDPOINT;
  const token = env.EXTERNAL_MODERATION_TOKEN;

  if (!token || !endpoint) {
    // Counted, not observed on the histogram: no request is issued, so this is not a latency
    // sample. Recorded before the span opens — a deployment with the integration switched off
    // should pay nothing beyond a counter increment.
    recordExternalModerationSkipped(metricSource);
    return { flagged: false, categories: [] };
  }

  const preparedPrompt = removeFalsePositiveTriggers(prompt);

  // Dark measurement: would a verdict cache have avoided this call? Off by default, fire-and-forget,
  // reads nothing back — the request below is issued either way. Placed HERE, on `preparedPrompt`
  // rather than on `prompt`, because that is the exact string the classifier receives, so the digest
  // matches what a real cache would key on. `removeFalsePositiveTriggers` is many-to-one, so probing
  // the raw prompt instead would count two requests that produce an identical classifier call as
  // distinct and UNDERSTATE the repeat rate.
  //
  // It also runs BEFORE the outcome is known, so it claims a window slot even for a call that then
  // fails. A real cache would store only successful verdicts, so this overstates the hit rate by
  // exactly the non-`ok` share — measured at ~0.01% in production, i.e. immaterial, but stated
  // rather than assumed. That is the SAME DIRECTION as the coalescing effect documented on the
  // `SET NX` in the probe module: both make the reported hit rate optimistic, which is why the
  // help text calls the result an upper bound and not a floor.
  probeModerationCacheRepeat(metricSource, preparedPrompt);

  // Wall-clock timing of the whole classifier call — the interval the generation submission actually
  // parks on. Started before the span so the observation cannot be biased by span setup, and read
  // exactly once per exit path below (resolve XOR throw), never in a `finally`, which could not see
  // the outcome the label needs.
  const start = performance.now();
  const elapsedSeconds = () => (performance.now() - start) / 1000;

  return await withSpan(
    'moderation:external-prompt',
    { 'moderation.source': metricSource },
    async () => {
      try {
        // Hard timeout via AbortSignal. Node's undici `fetch` has NO request timeout by
        // default (~300s headers/body), so a slow/hanging moderation gateway would park
        // this await — and since it runs inline on every generation submission
        // (`generateFromGraph` → `auditPromptServer`), that parks the whole tRPC request
        // off-CPU for minutes (observed ~194s api-primary tail during a moderation 503/504
        // wave). The call is already FAIL-SOFT (the caller catches and proceeds with
        // flagged:false) and the local regex audit still gates regardless, so aborting a
        // slow call only drops the secondary external layer for that one request — it does
        // not weaken the primary block. Abort → throws → caller's existing catch fails soft.
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            input: preparedPrompt,
            model: 'omni-moderation-latest',
          }),
          signal: AbortSignal.timeout(env.EXTERNAL_MODERATION_TIMEOUT_MS),
        });
        if (!res.ok) {
          let message = `External moderation failed: ${res.status} ${res.statusText}`;
          try {
            const body = await res.text();
            message += `\n${body}`;
          } catch (err) {}
          throw new Error(message);
        }

        const { results } = await res.json();
        let flagged = results[0].flagged;
        let categories = Object.entries(results[0].category_scores)
          .filter(([, v]) => (v as number) > env.EXTERNAL_MODERATION_THRESHOLD)
          .map(([k]) => k);

        // If we have categories
        // Only flag if any of them are found in the results
        if (env.EXTERNAL_MODERATION_CATEGORIES) {
          categories = [];
          for (const [k, v] of Object.entries(env.EXTERNAL_MODERATION_CATEGORIES)) {
            if (results[0].categories[k]) categories.push(v ?? k);
          }
          flagged = categories.length > 0;
        }

        recordOutcome(metricSource, 'ok', elapsedSeconds());
        return { flagged, categories };
      } catch (e) {
        // Exactly one observation per call — here on the throw path, XOR on the resolve path above.
        // A fired `AbortSignal.timeout` is its own outcome: it costs a full deadline of wall time
        // and calls for a different fix than a gateway that rejects immediately.
        recordOutcome(
          metricSource,
          isAbortDeadlineError(e) ? 'timeout' : 'error',
          elapsedSeconds()
        );
        throw e;
      }
    }
  );
}

/**
 * Record the histogram observation and stamp the same outcome on the active span, so a trace and the
 * metric can never disagree about how one call settled. Called from INSIDE the `withSpan` callback,
 * where `moderation:external-prompt` is the active span — outside it the attribute would land on the
 * caller's span instead.
 */
function recordOutcome(
  source: ExternalModerationSource,
  outcome: 'ok' | 'error' | 'timeout',
  durationSeconds: number
) {
  observeExternalModeration(source, outcome, durationSeconds);
  setActiveSpanAttributes({ 'moderation.outcome': outcome });
}

export const extModeration = {
  moderatePrompt,
};
