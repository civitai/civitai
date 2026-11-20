/**
 * Cutover for the content-policy service (apps/content-policy-go): with
 * `REGISTRY_ADAPTER_POLICY_ENFORCE=1` (and the shadow's `REGISTRY_ADAPTER_POLICY_URL`), a signed-in
 * user's subscription streams the audience the service answers instead of the one this source
 * decided (`audience.ts`). Off by default, and off whenever the shadow is off: then every
 * subscription is decided exactly as before, and the shadow (if on) only compares.
 *
 * When on, for each subscription once its token is accepted:
 *   - a signed-in user's is sent to the service as the shadow sends it (`policy-shadow.ts`, the
 *     same request and comparison, so `registry_adapter_policy_shadow_total` keeps counting), and
 *     the subscription waits for the answer, at most `REGISTRY_ADAPTER_POLICY_TIMEOUT_MS`. That bound
 *     is on the wait, not the request: it holds even with the repo's outbound deadline switched
 *     off (`outbound-fetch-timeouts-off`), and a request still waiting past it finishes in the
 *     background, counted by the shadow, within the shadow's in-flight cap;
 *   - an answer that is a decision and that an {@link Audience} can express is streamed, counted
 *     `registry_adapter_policy_enforce_total{source="service",reason="agree"|"disagree"}`. A
 *     disagreement is still the service's answer, and is logged as one line naming the two
 *     audience keys (nothing that identifies the viewer);
 *   - anything else is this source's own decision, unchanged, counted
 *     `{source="fallback_local",reason}`: `timeout`, `error` (refused, or an HTTP error), `fallback`
 *     (the service's own fail-closed answer), `malformed` (not a decision, or one no audience can
 *     express: G, PG and PG-13 always reach everyone here, and an unknown rating reaches exactly
 *     the audiences that read every mature rating), `dropped` (the in-flight cap was full) or
 *     `no_user_id` (a subject with no user id). A failure never narrows a stream to SFW and never
 *     fails the subscription;
 *   - two kinds are never decided by the service and keep this source's decision, counted
 *     `{source="local"}`, and are still compared in the background as in shadow mode:
 *       - `reason="service"`: an allowlisted service principal (`auth.ts`). It has no viewer, and its
 *         audience is this source's allowlist decision (`SERVICE_AUDIENCE`), not a policy's;
 *         the service is not asked, as in shadow mode;
 *       - `reason="anonymous"`: no token. Its audience is already the narrowest one an
 *         {@link Audience} can express (no mature rating), so the service could only agree or
 *         widen it, and an anonymous stream is never widened; not waiting also keeps anonymous
 *         subscriptions as fast as before.
 *
 * The service's answer is applied when the stream starts. A token re-check (`watchPrincipal`)
 * still re-applies this source's own rule only to notice a changed setting, which ends the stream
 * with `cursor_expired`; the next subscription asks the service again.
 */
import type { Counter, Registry } from 'prom-client';
import { Counter as PromCounter } from 'prom-client';
import type { Audience } from '~/server/registry-adapter/audience';
import { audienceOf } from '~/server/registry-adapter/audience';
import type { Principal } from '~/server/registry-adapter/auth';
import type {
  NoDecision,
  PolicyAnswer,
  PolicyComparison,
  PolicyShadow,
} from '~/server/registry-adapter/policy-shadow';
import {
  DEFAULT_POLICY_TIMEOUT_MS,
  POLICY_CONTEXT,
  POLICY_RATINGS,
  runShadow,
  shadowOf,
  startPolicyShadow,
} from '~/server/registry-adapter/policy-shadow';

/** Every `{source, reason}` pair the enforce counter can carry. */
export const ENFORCE_OUTCOMES = [
  ['service', 'agree'],
  ['service', 'disagree'],
  ['fallback_local', 'timeout'],
  ['fallback_local', 'error'],
  ['fallback_local', 'fallback'],
  ['fallback_local', 'malformed'],
  ['fallback_local', 'dropped'],
  ['fallback_local', 'no_user_id'],
  ['local', 'service'],
  ['local', 'anonymous'],
] as const;

/** One subscription's principal, decided by the service when it can be. Never rejects. */
export type PolicyEnforcer = (s: Parameters<PolicyShadow>[0]) => Promise<Principal>;

/** The enforce counter, on the shadow's registry (one `/metrics`). */
export function createEnforceMetrics(registry: Registry) {
  const counter = new PromCounter({
    name: 'registry_adapter_policy_enforce_total',
    help: 'Subscriptions while the content-policy service decides (REGISTRY_ADAPTER_POLICY_ENFORCE=1), by where their audience came from: service (its answer; reason agree or disagree with this source), fallback_local (this source, because the service gave no usable answer; reason timeout, error, fallback, malformed, dropped, no_user_id), local (a kind the service never decides; reason service or anonymous).',
    labelNames: ['source', 'reason'],
    registers: [registry],
  });
  // Every outcome from zero, so a fallback rate that never moved reads 0, not an absent series.
  for (const [source, reason] of ENFORCE_OUTCOMES) counter.inc({ source, reason }, 0);
  return counter;
}

/**
 * The audience the service's answer describes, or null when no {@link Audience} can express it: a
 * rating name the service does not list, G, PG or PG-13 left out (this source sends those to
 * everyone), or an unknown-rating answer other than "only to an audience that reads every mature
 * rating" (`audienceAdmits`).
 */
export function serviceAudience(answer: PolicyAnswer): Audience | null {
  const known: readonly string[] = POLICY_RATINGS;
  if (answer.ratings.some((r) => !known.includes(r))) return null;
  const has = new Set(answer.ratings);
  if (!has.has('g') || !has.has('pg') || !has.has('pg13')) return null;
  const allowed = { r: has.has('r'), x: has.has('x'), xxx: has.has('xxx') };
  if (answer.unknownRating !== (allowed.r && allowed.x && allowed.xxx)) return null;
  return audienceOf(allowed);
}

/** `p`, or `null` once `ms` have passed without it. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export function createPolicyEnforcer(opts: {
  compare: PolicyComparison;
  counter: Counter<'source' | 'reason'>;
  /** The longest a subscription waits for the service (`DEFAULT_POLICY_TIMEOUT_MS`). */
  waitMs?: number;
  log?: (line: string) => void;
}): PolicyEnforcer {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const waitMs = opts.waitMs ?? DEFAULT_POLICY_TIMEOUT_MS;
  const count = (source: 'service' | 'fallback_local' | 'local', reason: string) =>
    opts.counter.inc({ source, reason });
  const fallback = (reason: NoDecision) => count('fallback_local', reason);
  return async (s) => {
    const { principal } = s;
    if (principal.service === true || principal.subject === null) {
      // Kept local (see the file comment); still compared, without waiting, as in shadow mode.
      runShadow(shadowOf(opts.compare), s);
      count('local', principal.service === true ? 'service' : 'anonymous');
      return principal;
    }
    try {
      const c = await within(opts.compare(s), waitMs);
      if (!c) {
        fallback('timeout');
        return principal;
      }
      if (c.result !== 'agree' && c.result !== 'disagree') {
        fallback(c.result === 'service' ? 'error' : c.why);
        return principal;
      }
      const audience = serviceAudience(c.answer);
      if (!audience) {
        fallback('malformed');
        return principal;
      }
      if (c.result === 'disagree') {
        log(
          `registry-adapter: policy enforce disagree applied=service local=${principal.audience.key} ` +
            `service=${audience.key} context=${POLICY_CONTEXT}`
        );
      }
      count('service', c.result);
      return audience.key === principal.audience.key ? principal : { ...principal, audience };
    } catch {
      fallback('error');
      return principal;
    }
  };
}

/** Both bindings' one call: the subscription's principal, with the shadow or enforcement applied. */
export async function decidePrincipal(
  opts: { policyShadow?: PolicyShadow; policyEnforce?: PolicyEnforcer },
  s: Parameters<PolicyShadow>[0]
): Promise<Principal> {
  if (!opts.policyEnforce) {
    runShadow(opts.policyShadow, s);
    return s.principal;
  }
  try {
    return await opts.policyEnforce(s);
  } catch {
    // An enforcer never rejects; were it to, the subscription keeps this source's decision.
    return s.principal;
  }
}

/**
 * Whether enforcement is asked for: `REGISTRY_ADAPTER_POLICY_ENFORCE=1`. Unset, empty or `0` is
 * off; any other value is off with a warning, so a typo never reads as on.
 */
export function policyEnforceFromEnv(env: Record<string, string | undefined>): {
  on: boolean;
  warning?: string;
} {
  const raw = env.REGISTRY_ADAPTER_POLICY_ENFORCE;
  if (raw === '1') return { on: true };
  if (raw === undefined || raw === '' || raw === '0') return { on: false };
  return { on: false, warning: 'REGISTRY_ADAPTER_POLICY_ENFORCE must be 1 to enforce' };
}

/**
 * The shadow and, when asked for, enforcement, as `main.ts` starts them. Enforcement needs the
 * shadow's service: asked for while the shadow is off (no or an invalid URL) it is one warning and
 * off. It never stops the adapter.
 */
export function startPolicy(
  env: Record<string, string | undefined>,
  {
    log = (line: string) => console.log(line),
    warn = (line: string) => console.warn(line),
  }: { log?: (line: string) => void; warn?: (line: string) => void } = {}
): ReturnType<typeof startPolicyShadow> & { enforce?: PolicyEnforcer } {
  const started = startPolicyShadow(env, { log, warn });
  const asked = policyEnforceFromEnv(env);
  if (asked.warning) warn(`registry-adapter: WARNING: policy enforce off: ${asked.warning}`);
  if (!asked.on) return started;
  if (!started.compare || !started.registry) {
    warn('registry-adapter: WARNING: policy enforce off: the policy shadow is off');
    return started;
  }
  const enforce = createPolicyEnforcer({
    compare: started.compare,
    counter: createEnforceMetrics(started.registry),
    waitMs: started.timeoutMs,
  });
  log(
    'registry-adapter: policy enforce ON: a signed-in subscription streams the content-policy ' +
      "service's audience; on any failure, this source's own"
  );
  return { ...started, enforce };
}
