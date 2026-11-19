import { env } from '~/env/server';

/**
 * Civitai → orchestrator helpers for per-subject buzz spend tracking.
 *
 * The orchestrator owns spend enforcement and rolling-window math. Civitai
 * stores limits, exposes them on /api/v1/me, invalidates the orchestrator's
 * cache when a limit changes, and reads spend back per subject for UI
 * display.
 *
 * A "subject" is an opaque (type, id) pair from the orchestrator's POV:
 *  - `apiKey` + numeric ApiKey.id   — for User-type API keys
 *  - `oauth`  + clientId (string)   — for OAuth-issued tokens (the consent
 *                                     is the stable identifier across
 *                                     access-token rotations)
 *
 * Endpoints (Koen, 2026-05-08):
 *
 *   GET    /v1/manager/users/:userId/auth/:type/:id/limits
 *     →   { userId, subject, rules:[…], buckets:[…] }
 *     404 → no spend / limit data for this subject (treat as zero)
 *
 *   DELETE /v1/manager/users/:userId/auth/:type/:id/limits
 *     →   204 — invalidates the orchestrator's cache for this subject
 *
 *   DELETE /v1/manager/users/:userId/auth/:type/:id
 *     →   204 — removes the subject record entirely
 *
 * Subject `type` is sent lowercase (`apiKey` / `oauth`); orchestrator echoes
 * back PascalCase in response bodies (`ApiKey` / `Oauth`). We normalize back
 * to our lowercase canonical form on parse so callers don't have to care.
 *
 * Auth: bearer with `ORCHESTRATOR_ACCESS_TOKEN` (the same Civitai system key
 * used by other `/v1/manager/*` integrations like flagged-consumers).
 */

import type { Subject, SubjectType } from '~/server/schema/api-key.schema';
import { outboundFetch } from '~/server/utils/fetch-timeout';
export type { Subject, SubjectType };

const baseUrl = () => env.ORCHESTRATOR_ENDPOINT ?? '';

function subjectPath(userId: number, subject: Subject) {
  return `/v1/manager/users/${userId}/auth/${subject.type}/${encodeURIComponent(
    String(subject.id)
  )}`;
}

function limitsPath(userId: number, subject: Subject) {
  return `${subjectPath(userId, subject)}/limits`;
}

async function orchestratorFetch(path: string, init?: RequestInit) {
  if (!env.ORCHESTRATOR_ENDPOINT || !env.ORCHESTRATOR_ACCESS_TOKEN) {
    throw new Error('Orchestrator endpoint or access token not configured');
  }
  const url = `${baseUrl()}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
  };
  return outboundFetch(url, {
    timeoutMs: 30_000,
    ...init,
    headers: { ...headers, ...init?.headers },
  });
}

/**
 * Invalidate the orchestrator's cached limit for a subject. Called when the
 * user edits the buzz limit on a key or connected app so the next request
 * from that subject re-fetches via /api/v1/me.
 */
export async function bustBuzzLimitCache(args: {
  userId: number;
  subject: Subject;
}): Promise<void> {
  const response = await orchestratorFetch(limitsPath(args.userId, args.subject), {
    method: 'DELETE',
  });
  // 404 is fine — nothing to invalidate. Other non-2xx is a real error.
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Orchestrator DELETE auth/limits failed: ${response.status} ${response.statusText}`
    );
  }
}

export type BuzzSpendBucket = { ts: string; amount: number; currency: string };

export type BuzzSpendRule = {
  type: string;
  limit: number;
  spend: number;
  remaining: number;
  window?: string;
  unit?: number;
};

/**
 * Per-subject spend snapshot returned by the orchestrator. Shape echoed back
 * to the UI: type + id locate the subject; spend is the total in the current
 * tracked window(s); rules carry the per-budget breakdown; buckets are the
 * raw event log.
 */
export type BuzzSpendEntry = {
  type: SubjectType;
  id: number | string;
  spend: number;
  rules: BuzzSpendRule[];
  buckets: BuzzSpendBucket[];
};

type OrchestratorLimitsResponse = {
  userId: number;
  subject?: { type?: string; id?: string | number };
  rules?: Array<Partial<BuzzSpendRule>>;
  buckets?: Array<{ timestamp?: string; amount?: number; currency?: string }>;
};

/**
 * Fetch the orchestrator's spend snapshot for a single subject. Returns null
 * on 404 (no spend / no limit tracked yet) so the caller can treat absence
 * uniformly with empty results.
 *
 * Normalizes case-sensitive fields the orchestrator returns in mixed casing
 * (`ApiKey`, `Day`, `Blue`) so downstream code can compare them without
 * caring about the wire format.
 */
export async function getBuzzLimitForSubject(args: {
  userId: number;
  subject: Subject;
}): Promise<BuzzSpendEntry | null> {
  const response = await orchestratorFetch(limitsPath(args.userId, args.subject));
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Orchestrator GET auth/limits failed: ${response.status} ${response.statusText}`
    );
  }
  const body = (await response.json()) as OrchestratorLimitsResponse;

  const rules: BuzzSpendRule[] = (body.rules ?? []).map((r) => ({
    type: (r.type ?? '').toLowerCase(),
    limit: r.limit ?? 0,
    spend: r.spend ?? 0,
    remaining: r.remaining ?? 0,
    window: r.window ? r.window.toLowerCase() : undefined,
    unit: r.unit,
  }));

  const buckets: BuzzSpendBucket[] = (body.buckets ?? []).map((b) => ({
    ts: b.timestamp ?? '',
    amount: b.amount ?? 0,
    currency: (b.currency ?? '').toLowerCase(),
  }));

  // Total spend is the max across rules — each rule tracks the same underlying
  // spend stream against a different cap. If the orchestrator returns no
  // rules (subject seen but no limit configured) fall back to summing buckets.
  const ruleSpend = rules.length > 0 ? Math.max(...rules.map((r) => r.spend)) : 0;
  const fallbackSpend = buckets.reduce((s, b) => s + b.amount, 0);

  return {
    type: args.subject.type,
    id: args.subject.id,
    spend: ruleSpend || fallbackSpend,
    rules,
    buckets,
  };
}

/**
 * Fan-out fetch — one GET per subject, in parallel, swallow individual
 * failures so a single orchestrator hiccup doesn't blank the whole UI.
 *
 * Confirmed with Koen 2026-05-07: no batched list endpoint coming. He stores
 * subjects in Mongo with no deletion policy, so a list response would return
 * stale entries Civitai has forgotten about. Civitai is the source of truth
 * for which subjects exist; per-subject GETs are simpler and just as fast.
 * Caller is expected to filter the subject list to ones with limits set
 * before calling, so unlimited keys/consents don't generate 404 traffic.
 */
export async function getBuzzSpendForSubjects(
  userId: number,
  subjects: Subject[]
): Promise<BuzzSpendEntry[]> {
  const results = await Promise.all(
    subjects.map((subject) => getBuzzLimitForSubject({ userId, subject }).catch(() => null))
  );
  return results.filter((r): r is BuzzSpendEntry => r !== null);
}

/**
 * Delete the orchestrator's stored record for a subject — called when the
 * user deletes the underlying API key (so the subject is gone) or revokes a
 * connected app (so the OAuth consent is gone). Best-effort: 404 means
 * already absent, anything else is logged but doesn't fail the user
 * mutation.
 *
 * Endpoint (Koen, 2026-05-07):
 *   DELETE /v1/manager/users/:userId/auth/:type/:id
 *     →   204 — subject removed (or never existed)
 */
export async function deleteAuthSubject(args: { userId: number; subject: Subject }): Promise<void> {
  const response = await orchestratorFetch(subjectPath(args.userId, args.subject), {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Orchestrator DELETE auth subject failed: ${response.status} ${response.statusText}`
    );
  }
}
