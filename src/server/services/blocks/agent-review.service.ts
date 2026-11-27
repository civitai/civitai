import type { AppReviewAgentReport } from '@prisma/client';
// Type-only: the client itself is imported lazily inside each function, as before.
import type { dbRead as dbReadClient } from '~/server/db/client';
import type { ConnectCivitaiChecks } from '~/shared/constants/connect-agent-review.constants';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import {
  assertAppsNamespaceWritable,
  getDp1Target,
  k8sFetch,
  unwrap,
} from '~/server/services/blocks/apps-pipeline.service';
import {
  AGENT_REVIEW_SECTIONS,
  isAgentSectionFailureMarker,
  type AgentReviewSection,
} from '~/shared/constants/agent-review-section.constants';
import {
  agentReviewLaneFor,
  type AgentReviewLane,
} from '~/shared/constants/connect-agent-review.constants';
import {
  AGENT_REVIEW_MODEL_MAX_PROMPT_PER_M,
  fromRunnerModelId,
  toRunnerModelId,
  type AgentReviewModelOption,
} from '~/shared/constants/agent-review-model.constants';
import type { AgentReviewModelRefusal } from '~/server/services/blocks/agent-review-models.service';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P1) — provisioning lane.
 *
 * A moderator reviewing a PENDING publish request can dispatch an EPHEMERAL,
 * sandboxed review agent. Two lanes share this one dispatcher: on-site
 * (`AppBlockPublishRequest`, the hosted bundle) and OAuth-connect
 * (`AppListingPublishRequest`, see `connect-agent-review.service`). This service is
 * the civitai side of that:
 *   - `startAgentReview` gathers the reviewed bundle (presigned for in-cluster
 *     pull), the prior-version report, mints a per-review callback bearer, writes
 *     a `running` report row, and provisions a k8s apply Job that renders the
 *     already-shipped `review-agent.yaml.tmpl` (from the `app-templates`
 *     ConfigMap) via envsubst + `kubectl apply` — MIRRORING the review-sandbox
 *     apply lane (`triggerApplyReview`) exactly.
 *   - `deleteAgentReviewResources` tears the agent's k8s objects down by label
 *     selector (best-effort, idempotent, never throws) — called from the shared
 *     `teardownReviewForRequest` decision hook.
 *
 * DARK: `startAgentReview` is only reachable via a tRPC procedure gated per lane:
 * `app-blocks-agentic-review` for on-site, `app-listings-agentic-review` for connect
 * (`isAgentReviewLaneEnabled`). Either flag absent → that lane is inert.
 *
 * Everything is a thin REST wrapper over the in-pod ServiceAccount k8s API (no
 * kubernetes-client dependency), reusing `k8sFetch`/`getDp1Target` from the
 * apps-pipeline service. Infra identifiers come from EXISTING env
 * (`env.APPS_KUBE_NAMESPACE`) — none are hardcoded here.
 */

/** Presigned-bundle TTL. The agent pod's init curls it once, shortly after the
 *  apply Job creates the Deployment; a few minutes covers image-pull + init. */
export const AGENT_REVIEW_BUNDLE_PRESIGN_TTL_SECONDS = 15 * 60;

/**
 * Derive the DNS-label-safe agent object name from a publishRequestId. Must be
 * ≤63 chars and match `[a-z0-9-]`. A short hex hash of the id keeps it stable
 * (idempotent re-runs target the same objects) AND well under the label limit
 * (`review-agent-` = 13 chars + 12 hex = 25). Exported so tests + teardown can
 * derive the same name the apply Job renders.
 */
export function agentReviewName(publishRequestId: string): string {
  // Lazy require: crypto is node-builtin, kept off the module top so this stays
  // import-cheap for the (dark) importers.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('crypto') as typeof import('crypto');
  const hash = createHash('sha1').update(publishRequestId).digest('hex').slice(0, 12);
  return `review-agent-${hash}`;
}

/**
 * 🔴 THE LEDGER IS SHARED, NOT RESTATED. `AGENT_REVIEW_SECTIONS` and the failure predicate
 * live in `~/shared/constants/agent-review-section.constants` so this service, the tRPC
 * input schema and the client renderer all read ONE list — see that module for what the
 * four separate copies used to make possible (a full re-run silently classified as targeted,
 * seeding stale verdicts into fresh analysis).
 */

export type StartAgentReviewArgs = {
  publishRequestId: string;
  /** Calling moderator's id, or `null` for the automatic start when a review preview goes live
   *  (review-autodeploy.service, under the platform's daily agent-review budget). */
  modUserId: number | null;
  /**
   * Re-run only these analyses. Omitted (or all three) ⇒ a full run.
   *
   * See {@link startAgentReview} step (d') for what a SUBSET does on this side, and
   * `startAgentReviewSchema` for what it does not yet buy.
   */
  sections?: readonly AgentReviewSection[];
  /**
   * Run on this OpenRouter model instead of the review agent's default (a second opinion, or a
   * way round a default model that stopped working). Omitted on a full run ⇒ the default, and
   * the Job sets no model values.
   *
   * 🔴 ON A TARGETED RE-RUN IT MUST BE THE LATEST RUN'S OWN MODEL. A targeted re-run carries the
   * other analyses forward from the latest report, and a report row names one model, so the
   * re-run analysis has to come from the model that wrote the carried ones. The service refuses
   * any other model (including none, when the latest run named one).
   */
  model?: string;
};

export type StartAgentReviewResult = {
  reportId: string;
  agentName: string;
};

/**
 * Dispatch an ephemeral review agent for a PENDING publish request of either lane.
 *
 * Steps (mirroring the review-sandbox lane's shape):
 *   a. Load the AppBlockPublishRequest (slug, bundle pointers, version, app key,
 *      forgejo commit) — or, on the connect lane, the AppListingPublishRequest and its
 *      listing + OAuth client, staging a review ZIP built from them.
 *   b. Resolve ONE presigned MinIO object the pod pulls: the canonical bundle
 *      (`bundleKey`) if the ZIP was uploaded, else reconstruct-from-Forgejo and
 *      stage it to a per-review key, then presign THAT. Either way the pod pulls
 *      one read-only object and never talks to Forgejo.
 *   c. Look up the prior-version report (base64 for the pod) so the agent can
 *      diff against the last review.
 *   d. Insert a `running` report row.
 *   e. Mint the per-review callback bearer (bound to publishRequestId).
 *   f. Provision the apply Job that envsubst-renders `review-agent.yaml.tmpl` +
 *      `kubectl apply`s it.
 *
 * On a provisioning failure the just-inserted row is flipped to `failed` so it
 * never lingers `running`.
 */
export async function startAgentReview(
  args: StartAgentReviewArgs
): Promise<StartAgentReviewResult> {
  const { publishRequestId } = args;
  // A list naming every section is a FULL run, not a targeted one — so an exhaustive
  // selection cannot accidentally take the carry-forward path below (there would be
  // nothing to carry) nor stamp a pointless env var on the Job.
  const requested = args.sections ? Array.from(new Set(args.sections)) : [];
  const targeted = requested.length > 0 && requested.length < AGENT_REVIEW_SECTIONS.length;
  // A targeted re-run is only allowed on the model of the run it carries from — checked
  // before anything is staged or written.
  const latest = targeted
    ? await (await import('./app-review-report.service')).getAgentReport(publishRequestId)
    : null;
  if (targeted) assertSameModelAsLatest(args.model, latest?.model ?? null);
  // Resolved (and priced) before anything is staged or written, so an unknown model costs nothing.
  let analysisModel: AgentReviewModelOption | null = null;
  if (args.model) {
    const { resolveAgentReviewModel, AgentReviewModelRefusedError } = await import(
      './agent-review-models.service'
    );
    try {
      analysisModel = await resolveAgentReviewModel(args.model);
    } catch (err) {
      // On a targeted re-run the model was not the moderator's choice but the latest run's, and
      // it can no longer be used (retired, unlisted, over the price ceiling, or the list is
      // unreachable). The refusal says which, from the resolver's own reason.
      if (targeted) {
        throw cannotRerunOnLatestModel(
          args.model,
          err instanceof AgentReviewModelRefusedError ? err.refusal : undefined
        );
      }
      throw err;
    }
  }
  const { dbRead, dbWrite } = await import('~/server/db/client');

  // ONE DISPATCHER, TWO LANES. The id says which publish request this is: an on-site
  // AppBlockPublishRequest (a hosted bundle) or an OAuth-connect AppListingPublishRequest
  // (scopes, listing claims, linked source). Only steps (a)–(c) differ; the running guard,
  // carry-forward, report row, bearer, Job and audit below are shared.
  const lane = agentReviewLaneFor(publishRequestId);
  const subject =
    lane === 'connect'
      ? await prepareConnectSubject(publishRequestId, dbRead)
      : await prepareOnsiteSubject(publishRequestId, dbRead);

  const bundleObjectKey = subject.bundleObjectKey;
  const { presignBundleGet } = await import('~/utils/bundle-s3');
  const bundlePresignedUrl = await presignBundleGet(
    bundleObjectKey,
    AGENT_REVIEW_BUNDLE_PRESIGN_TTL_SECONDS
  );

  // (c) Prior-version report → base64 JSON for the pod (empty string if none).
  // Keyed by the stable slug so the chain resolves for a first version too. A connect
  // listing has no version chain, so it has no prior.
  let prior: AppReviewAgentReport | null = null;
  if (subject.lane === 'onsite') {
    const { getPriorAgentReport } = await import('./app-review-report.service');
    prior = await getPriorAgentReport({ slug: subject.slug, version: subject.version });
  }
  const priorReportJsonB64 = prior ? Buffer.from(JSON.stringify(prior)).toString('base64') : '';

  // (d') TARGETED RE-RUN — carry forward the sections we are NOT re-running.
  //
  // 🔴 WITHOUT THIS, A TARGETED RETRY WOULD DESTROY THE VERY THING IT EXISTS TO PRESERVE.
  // A re-run inserts a NEW report row and `getAgentReport` returns the most recently
  // started one, so retrying one analysis would replace a report holding two good sections
  // with a report holding one. Seeding the new row from the LATEST report's surviving
  // sections makes a targeted retry strictly additive: the runner's callback then
  // overwrites whatever it actually produced (`buildReportUpdate` writes only the fields
  // the body carries, so an omitted section keeps the seeded value), and the mod never
  // loses a completed analysis — whether or not the agent honours the section list.
  //
  // Only on the targeted path. A full re-run is a fresh analysis of the same bundle and
  // must not inherit stale verdicts from the run it replaces.
  const carried: Record<string, unknown> = {};
  if (targeted) {
    if (latest) {
      const keep = AGENT_REVIEW_SECTIONS.filter((s) => !requested.includes(s));
      for (const section of keep) {
        const value = latest[section];
        // Skip a null/absent slot, and skip a slot that is itself a failure marker: seeding
        // a `{ error: … }` forward would re-report an old failure as if it were this run's.
        if (value == null) continue;
        if (isAgentSectionFailureMarker(value)) continue;
        // The old run's impersonation record does not describe this run: the check runs again
        // when this run reports, and until then there is no record (so no fast lane).
        carried[section] =
          section === 'securityAudit'
            ? (await import('./app-impersonation.logic')).stripImpersonationRecord(value)
            : value;
      }
      // The model string describes the run that produced the carried content; keep it so a
      // partially-seeded report is not attributed to nothing.
      if (Object.keys(carried).length > 0 && latest.model) carried.model = latest.model;
    }
  }

  // (d) Insert the running report row, keyed by `slug`. On-site: kind='onsite', `appBlockId`
  // informational (null for a first version). Connect: kind='external' with the OAuth client;
  // what Civitai checked itself goes to its own table just below, never into these sections.
  const { newAppReviewAgentReportId } = await import('~/server/utils/app-block-ids');
  const reportId = newAppReviewAgentReportId();
  const laneData: Record<string, unknown> =
    subject.lane === 'connect'
      ? { kind: 'external', appBlockId: null, oauthClientId: subject.oauthClientId }
      : { kind: 'onsite', appBlockId: subject.appBlockId };
  await dbWrite.appReviewAgentReport.create({
    data: {
      ...carried,
      id: reportId,
      publishRequestId,
      slug: subject.slug,
      ...laneData,
      version: subject.version,
      bundleSha256: subject.bundleSha256,
      status: 'running',
      startedAt: new Date(),
      priorReportId: prior?.id ?? null,
      // Named up front so the run is identifiable while it is running.
      ...(analysisModel ? { model: toRunnerModelId(analysisModel.id) } : {}),
    },
  });

  if (subject.lane === 'connect') await finishConnectInsert(subject, reportId, publishRequestId);

  return provisionAndRecordStart({
    args,
    lane: subject.lane,
    slug: subject.slug,
    reportId,
    bundlePresignedUrl,
    priorReportJsonB64,
    sections: targeted ? requested : undefined,
    analysisModel: analysisModel
      ? {
          model: toRunnerModelId(analysisModel.id),
          priceInPerM: String(analysisModel.promptPerM),
          priceOutPerM: String(analysisModel.completionPerM),
        }
      : undefined,
  });
}

const RERUN_ALL_HINT =
  'Use "Re-run all analyses" (with a model chosen if you like) to get a fresh report instead.';

/** Why the report's model cannot be used, as the tail of the single-section refusal. */
function whyModelUnusable(refusal: AgentReviewModelRefusal | undefined): string {
  switch (refusal?.reason) {
    case 'over-ceiling':
      return `that model costs $${refusal.promptPerM} per million input tokens, above the $${AGENT_REVIEW_MODEL_MAX_PROMPT_PER_M} limit for agent reviews`;
    case 'not-listed':
      return 'that model is no longer a tool-capable model on OpenRouter';
    case 'list-unavailable':
      return "OpenRouter's model list could not be loaded to price that model (try again shortly)";
    default:
      return 'that model cannot be used now';
  }
}

function cannotRerunOnLatestModel(id: string, refusal?: AgentReviewModelRefusal): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: `This analysis can only be re-run on the model that wrote the rest of the report (${id}), and ${whyModelUnusable(
      refusal
    )}. ${RERUN_ALL_HINT}`,
  });
}

/**
 * A targeted re-run must name exactly the latest run's model (`null` when that run named none):
 * the carried analyses came from it, and a report row names one model. A stored model that is not
 * in the `openrouter/<id>` form cannot be re-run on at all.
 */
function assertSameModelAsLatest(requested: string | undefined, latestModel: string | null) {
  const required = latestModel == null ? null : fromRunnerModelId(latestModel);
  if (latestModel != null && required == null) throw cannotRerunOnLatestModel(latestModel);
  if ((requested ?? null) !== required) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `A single analysis has to be re-run on the model that wrote the rest of the report (${
        required ?? 'the default model'
      }), so its result is not mixed with another model's. ${RERUN_ALL_HINT}`,
    });
  }
}

type OnsiteSubject = {
  lane: 'onsite';
  slug: string;
  version: string;
  bundleSha256: string;
  bundleObjectKey: string;
  appBlockId: string | null;
};
type ConnectSubject = {
  lane: 'connect';
  slug: string;
  version: string;
  bundleSha256: string;
  bundleObjectKey: string;
  oauthClientId: string;
  checks: ConnectCivitaiChecks;
  fingerprint: string;
};
type DbRead = typeof dbReadClient;

/**
 * Double-provision guard (audit #3): refuse a second dispatch while a review is already
 * `running` for this request. The partial-unique index (publish_request_id WHERE
 * status='running') is the DB backstop; this is the friendly pre-check so the mod gets a clear
 * error instead of a unique-violation. Runs after the request is validated and BEFORE any
 * bundle is staged, in both lanes.
 */
async function assertNoRunningReview(publishRequestId: string, dbRead: DbRead): Promise<void> {
  const alreadyRunning = await dbRead.appReviewAgentReport.findFirst({
    where: { publishRequestId, status: 'running' },
    select: { id: true },
  });
  if (alreadyRunning) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'a review is already running for this request',
    });
  }
}

/** Connect lane (a)–(b): a pending OAuth-connect listing request; stage its review ZIP. */
async function prepareConnectSubject(
  publishRequestId: string,
  dbRead: DbRead
): Promise<ConnectSubject> {
  const { loadConnectReviewSubject, stageConnectReviewBundle } = await import(
    './connect-agent-review.service'
  );
  const loaded = await loadConnectReviewSubject(publishRequestId);
  await assertNoRunningReview(publishRequestId, dbRead);
  const staged = await stageConnectReviewBundle(loaded);
  // The source fetch can take a while: a moderator may have decided the request meanwhile.
  // Re-checked on the PRIMARY; decided ⇒ delete what was staged and stop before any row exists.
  await assertConnectStillPending(publishRequestId);
  return { lane: 'connect', ...staged };
}

const DECIDED_DURING_START = 'the submission was decided while the review was starting';

async function assertConnectStillPending(publishRequestId: string): Promise<void> {
  const { isConnectRequestStillPending, abandonDecidedConnectReview } = await import(
    './connect-agent-review.service'
  );
  if (await isConnectRequestStillPending(publishRequestId)) return;
  await abandonDecidedConnectReview(publishRequestId);
  throw new Error(DECIDED_DURING_START);
}

/**
 * Connect lane, right after the running row exists: store the Civitai checks (failure ⇒ the row is
 * marked failed and the start refuses), then re-check the request once more. A decision that
 * landed between the first re-check and the insert found no report to tear down, so it is caught
 * here instead; one landing after this read finds the row and its teardown takes it down.
 */
async function finishConnectInsert(
  subject: ConnectSubject,
  reportId: string,
  publishRequestId: string
): Promise<void> {
  const { writeConnectChecks } = await import('./connect-agent-review.service');
  try {
    await writeConnectChecks({
      reportId,
      publishRequestId,
      checks: subject.checks,
      fingerprint: subject.fingerprint,
    });
  } catch (err) {
    const { dbWrite } = await import('~/server/db/client');
    await dbWrite.appReviewAgentReport
      .updateMany({
        where: { id: reportId, status: 'running' },
        data: {
          status: 'failed',
          summaryMd: 'Could not store the Civitai checks for this review.',
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);
    throw err;
  }
  await assertConnectStillPending(publishRequestId);
}

/** On-site lane (a)–(b): the pending AppBlockPublishRequest and the ONE object the pod pulls. */
async function prepareOnsiteSubject(
  publishRequestId: string,
  dbRead: DbRead
): Promise<OnsiteSubject> {
  // (a) Load the pending on-site publish request. The whole review lane
  // (previewRequest / teardownReviewForRequest) targets AppBlockPublishRequest;
  // this mirrors it.
  const request = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: {
      id: true,
      slug: true,
      version: true,
      bundleKey: true,
      bundleSha256: true,
      appBlockId: true,
      forgejoCommitSha: true,
      status: true,
    },
  });
  if (!request) throw new Error(`publish request ${publishRequestId} not found`);
  if (request.status !== 'pending') {
    throw new Error(
      `publish request ${publishRequestId} is not pending (status=${request.status})`
    );
  }

  await assertNoRunningReview(publishRequestId, dbRead);

  // Resolve the INFORMATIONAL on-site app key. The report is keyed by the stable
  // `slug` (present on every request), so this is best-effort: an UPDATE carries
  // appBlockId, or an AppBlock already exists for the slug; a genuine FIRST
  // version has neither (the AppBlock is created on approve) → appBlockId stays
  // null. First-version reviews now persist fine (keyed by slug).
  let appBlockId = request.appBlockId ?? null;
  if (!appBlockId) {
    const existing = await dbRead.appBlock.findFirst({
      where: { blockId: request.slug },
      select: { id: true },
    });
    appBlockId = existing?.id ?? null;
  }

  const sha = request.bundleSha256;

  // (b) Resolve the ONE presigned object the pod pulls.
  let bundleObjectKey: string;
  if (request.bundleKey) {
    // ZIP path: the canonical bundle object already exists — presign it directly.
    bundleObjectKey = request.bundleKey;
  } else if (request.forgejoCommitSha) {
    // PUSH path (git-push origin, bundleKey===''): no ZIP was uploaded — the
    // Forgejo repo at the reviewed sha IS the artifact. Reconstruct the exact
    // reviewed bytes (deterministic; same helper approve uses) and STAGE them to
    // a per-review MinIO key so the pod pulls one presigned object (never Forgejo).
    const { reconstructBundleFromForgejo } = await import('./publish-request.service');
    const { agentReviewBundleKey, stageBundleObject } = await import('~/utils/bundle-s3');
    const buf = await reconstructBundleFromForgejo(request.slug, request.forgejoCommitSha);
    bundleObjectKey = agentReviewBundleKey(publishRequestId, sha);
    await stageBundleObject(bundleObjectKey, buf);
  } else {
    throw new Error(
      `publish request ${publishRequestId} has neither a bundle nor a forgejo commit to review`
    );
  }
  return {
    lane: 'onsite',
    slug: request.slug,
    version: request.version,
    bundleSha256: sha,
    bundleObjectKey,
    appBlockId,
  };
}

/** Steps (e)–(f) plus the audit, shared by both lanes. */
async function provisionAndRecordStart(opts: {
  args: StartAgentReviewArgs;
  lane: AgentReviewLane;
  slug: string;
  reportId: string;
  bundlePresignedUrl: string;
  priorReportJsonB64: string;
  sections: readonly AgentReviewSection[] | undefined;
  analysisModel: AnalysisModelEnv | undefined;
}): Promise<StartAgentReviewResult> {
  const { args, reportId, slug } = opts;
  const { publishRequestId } = args;
  const { dbWrite } = await import('~/server/db/client');

  // (e) Mint the per-review callback bearer bound to this publishRequestId. NOT
  // the fleet-wide BLOCK_BUILD_CALLBACK_SECRET — that must never reach the agent
  // pod. Short-TTL + request-scoped: a leaked token can only write a still-`running`
  // report of THIS publish request (the token binds the request, not one run's row).
  const { signAgentCallbackToken, deriveAgentHooksToken } = await import('./review-session');
  const callbackToken = signAgentCallbackToken({ publishRequestId });
  // Derive the per-review agent GATEWAY secret (no storage / no migration): the
  // pod is provisioned with this HOOKS_TOKEN and uses it as its gateway secret.
  // (The review chat no longer talks to the pod: it runs on civitai, grounded on
  // the persisted report.) Deterministic + review-scoped.
  const hooksToken = deriveAgentHooksToken(publishRequestId);
  // CONTAINMENT: prefer the IN-CLUSTER callback base (AGENT_REVIEW_CALLBACK_BASE_URL)
  // so the adversarial report + the per-review bearer never leave the cluster onto
  // the public internet. Falls back to the public NEXTAUTH_URL when the in-cluster
  // env is unset (keeps working before infra sets it ahead of un-dark). Read from
  // the VALIDATED env object, never process.env directly.
  const callbackBase = env.AGENT_REVIEW_CALLBACK_BASE_URL ?? env.NEXTAUTH_URL ?? '';
  const callbackUrl = `${callbackBase.replace(
    /\/$/,
    ''
  )}/api/internal/blocks/agent-report-callback`;

  const agentName = agentReviewName(publishRequestId);

  // (f) Provision the apply Job. On failure, flip the row to failed so it never
  // lingers `running`, then rethrow.
  try {
    // COST CEILING (audit #5): per review, POD-SIDE — the runner self-aborts (status
    // 'cost-capped') once its LLM spend crosses COST_CAP_USD. AUTOMATIC starts are also bounded
    // by a platform-wide daily budget (review-autodeploy.service); a moderator's start is not.
    await provisionAgentReviewJob({
      agentName,
      publishRequestId,
      slug,
      bundlePresignedUrl: opts.bundlePresignedUrl,
      callbackUrl,
      callbackToken,
      priorReportJsonB64: opts.priorReportJsonB64,
      costCapUsd: env.AGENT_REVIEW_COST_CAP_USD,
      hooksToken,
      // Only on a targeted re-run, so a full dispatch's Job body is byte-identical to what
      // it was before this contract var existed (and the orchestration test's exact env
      // ledger keeps proving that).
      sections: opts.sections,
      // Only on the connect lane, for the same reason: an on-site Job body is unchanged.
      reviewKind: opts.lane === 'connect' ? 'connect' : undefined,
      // Only when a model was named: a default-model Job sets no model values.
      analysisModel: opts.analysisModel,
    });
  } catch (err) {
    await dbWrite.appReviewAgentReport
      .updateMany({
        where: { id: reportId, status: 'running' },
        data: {
          status: 'failed',
          summaryMd: `Provisioning failed: ${
            err instanceof Error ? err.message : String(err)
          }`.slice(0, 500),
          completedAt: new Date(),
        },
      })
      .catch(() => {
        /* best-effort — the caller already sees the throw */
      });
    throw err;
  }

  // AUDIT: who started this run. An automatic start (no moderator) is recorded as `system`.
  // Fire-and-forget: the audit must never fail the start.
  const { logToAxiom } = await import('~/server/logging/client');
  logToAxiom(
    {
      name: 'app-blocks.review.agent-start',
      type: 'info',
      publishRequestId,
      reportId,
      slug,
      actor: args.modUserId == null ? 'system' : 'moderator',
      modUserId: args.modUserId,
      sections: opts.sections ?? null,
      model: opts.analysisModel?.model ?? null,
    },
    'webhooks'
  );

  return { reportId, agentName };
}

type ProvisionAgentReviewJobArgs = {
  agentName: string;
  publishRequestId: string;
  slug: string;
  bundlePresignedUrl: string;
  callbackUrl: string;
  callbackToken: string;
  priorReportJsonB64: string;
  costCapUsd: string;
  /** Derived per-review agent gateway secret (see deriveAgentHooksToken). The
   *  infra template feeds this into the pod's fetch-bundle init as the gateway
   *  secret; the chat proxy recomputes `sha256("gw-"+hooksToken)` to authenticate. */
  hooksToken: string;
  /**
   * The analyses to run, for a TARGETED re-run. Omitted ⇒ a full run, and then no
   * `AGENT_REVIEW_SECTIONS` var is set at all, so the Job body is unchanged from before
   * this existed.
   *
   * 🔴 THE POD SIDE OF THIS CONTRACT SHIPS SEPARATELY. The agent template has to read
   * `${AGENT_REVIEW_SECTIONS}` and skip the analyses it does not name; until it does, the
   * var is inert and a targeted re-run simply runs everything. That is never worse than the
   * whole-report re-run it replaces, and the carry-forward in `startAgentReview` step (d')
   * means the mod's surviving sections are safe either way.
   */
  sections?: readonly AgentReviewSection[];
  /**
   * `connect` on the connect lane ⇒ `AGENT_REVIEW_KIND=connect`; omitted on-site, so an on-site
   * Job body is unchanged. The bundle's contents do not choose the review kind: an on-site
   * author could ship a file of any name, but cannot set this var.
   *
   * 🔴 LIKE `AGENT_REVIEW_SECTIONS`, THE POD SIDE SHIPS SEPARATELY. Until the agent template
   * passes it to the runner and its skill reads it, a connect run is reviewed with the on-site
   * prompt; the facts Civitai writes itself are on the report either way.
   */
  reviewKind?: 'connect';
  /**
   * A moderator-chosen model ⇒ `ANALYSIS_MODEL` plus its `PRICE_IN_PER_M` / `PRICE_OUT_PER_M`;
   * omitted for the default model, so that Job sets no model values (its apply script's fallback
   * renders them empty, which the agent reads as its defaults). The price travels with the
   * model because the agent estimates its spend (and enforces `COST_CAP_USD`) from token counts
   * times a per-model price: without it a dearer model would be costed at the default's rate.
   *
   * 🔴 LIKE `AGENT_REVIEW_SECTIONS`, THE POD SIDE SHIPS SEPARATELY. The agent template has to
   * pass these three to the review agent, and the agent has to dispatch to `ANALYSIS_MODEL`, not
   * only label its report with it. Until it does they are inert: the run uses the default model
   * and its report says so.
   */
  analysisModel?: AnalysisModelEnv;
};

/** The chosen-model env values, already in the agent's format (`openrouter/<id>`, USD per M). */
type AnalysisModelEnv = { model: string; priceInPerM: string; priceOutPerM: string };

/**
 * Create the provisioning apply Job on dp-1's apps namespace. Mirrors
 * `triggerApplyReview`: same in-pod SA k8s surface, same `apps-applier` SA + the
 * same `app-templates` ConfigMap, but renders `review-agent.yaml.tmpl` with the
 * agent-review contract vars and applies it. The rendered objects carry the
 * template's labels (`civitai.com/role=review-agent`,
 * `civitai.com/publish-request-id=<id>`, `civitai.com/app-slug=<slug>`,
 * `review-mode=true`) — `deleteAgentReviewResources` sweeps on those.
 *
 * Exported so the orchestration test can lock the Job body + envsubst-var shape.
 */
export async function provisionAgentReviewJob(
  args: ProvisionAgentReviewJobArgs
): Promise<{ name: string }> {
  assertAppsNamespaceWritable('agent review Job');
  const target = await getDp1Target();
  const ns = env.APPS_KUBE_NAMESPACE;
  const jobName = `${args.agentName}-apply`;

  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: ns,
      labels: {
        app: jobName,
        'civitai.com/role': 'apply-job',
        'civitai.com/review-mode': 'true',
        'civitai.com/app-slug': args.slug,
        'civitai.com/publish-request-id': args.publishRequestId,
      },
    },
    spec: {
      backoffLimit: 2,
      // 24h TTL backstop — the approve/reject decision (teardownReviewForRequest)
      // tears the agent down; this only garbage-collects the apply Job itself.
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: {
          labels: {
            'civitai.com/role': 'apply-job',
            'civitai.com/review-mode': 'true',
            'civitai.com/app-slug': args.slug,
          },
        },
        spec: {
          serviceAccountName: 'apps-applier',
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'apply',
              image: 'alpine/k8s:1.34.0',
              imagePullPolicy: 'IfNotPresent',
              // Contract vars the shipped review-agent.yaml.tmpl consumes.
              // Object render vars + pod runtime env values (envsubst reads
              // process env, which container env vars auto-export into).
              // OPENROUTER_API_KEY is intentionally NOT passed — the pod reads it
              // from a namespace Secret.
              env: [
                { name: 'AGENT_NAME', value: args.agentName },
                { name: 'PUBLISH_REQUEST_ID', value: args.publishRequestId },
                { name: 'APP_SLUG', value: args.slug },
                { name: 'BUNDLE_PRESIGNED_URL', value: args.bundlePresignedUrl },
                { name: 'CALLBACK_URL', value: args.callbackUrl },
                { name: 'CALLBACK_TOKEN', value: args.callbackToken },
                { name: 'PRIOR_REPORT_JSON_B64', value: args.priorReportJsonB64 },
                { name: 'COST_CAP_USD', value: args.costCapUsd },
                // Derived per-review gateway secret for the in-modal chat proxy
                // (P3). The infra review-agent.yaml.tmpl consumes ${HOOKS_TOKEN}.
                { name: 'HOOKS_TOKEN', value: args.hooksToken },
                // Targeted re-run only — absent on a full run (see the arg's docstring).
                ...(args.sections && args.sections.length > 0
                  ? [{ name: 'AGENT_REVIEW_SECTIONS', value: args.sections.join(',') }]
                  : []),
                ...(args.reviewKind ? [{ name: 'AGENT_REVIEW_KIND', value: args.reviewKind }] : []),
                // Chosen model only — absent for the default (see the arg's docstring).
                ...(args.analysisModel
                  ? [
                      { name: 'ANALYSIS_MODEL', value: args.analysisModel.model },
                      { name: 'PRICE_IN_PER_M', value: args.analysisModel.priceInPerM },
                      { name: 'PRICE_OUT_PER_M', value: args.analysisModel.priceOutPerM },
                    ]
                  : []),
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'templates', mountPath: '/templates', readOnly: true },
                { name: 'tmp', mountPath: '/tmp' },
              ],
              command: ['/bin/bash', '-c'],
              args: [buildAgentReviewApplyScript(ns)],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
            },
          ],
          volumes: [
            { name: 'templates', configMap: { name: 'app-templates' } },
            { name: 'tmp', emptyDir: { sizeLimit: '8Mi' } },
          ],
        },
      },
    },
  };

  // Idempotency: re-dispatching for the same request must restart cleanly —
  // delete an existing same-name apply Job first (404 is fine). Mirrors the
  // review lane. The rendered Deployment/Service are reconciled by `kubectl
  // apply` inside the script.
  await k8sFetch(
    target,
    `/apis/batch/v1/namespaces/${ns}/jobs/${jobName}?propagationPolicy=Background`,
    { method: 'DELETE' }
  ).then(async (r) => {
    if (!r.ok && r.status !== 404) {
      const body = await r.text().catch(() => '');
      throw new Error(`pre-delete agent apply Job ${r.status}: ${body.slice(0, 240)}`);
    }
  });

  const res = await k8sFetch(target, `/apis/batch/v1/namespaces/${ns}/jobs`, {
    method: 'POST',
    body: JSON.stringify(job),
  });
  const created = await unwrap<{ metadata: { name: string } }>(res);
  return { name: created.metadata.name };
}

/**
 * The apply script: envsubst-render `review-agent.yaml.tmpl` + `kubectl apply`.
 *
 * SECURITY: unlike the review-sandbox apply script, this deliberately does NOT
 * `cat` the rendered manifest — it embeds the presigned bundle URL and the
 * callback bearer, which must not land in the apply-Job logs. There is also no
 * smoke test (the agent is not an HTTP block image; it pulls a bundle, analyses
 * it, and POSTs a report). Exported for the orchestration test.
 */
export function buildAgentReviewApplyScript(ns: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

# ---- Render the review-agent manifest from /templates/review-agent.yaml.tmpl --
# envsubst only substitutes EXPORTED env vars; container env vars are already
# exported into the process env, so AGENT_NAME / PUBLISH_REQUEST_ID / APP_SLUG /
# BUNDLE_PRESIGNED_URL / CALLBACK_URL / CALLBACK_TOKEN / PRIOR_REPORT_JSON_B64 /
# COST_CAP_USD / HOOKS_TOKEN all substitute. AGENT_REVIEW_KIND, AGENT_REVIEW_SECTIONS and
# the chosen-model trio (ANALYSIS_MODEL, PRICE_IN_PER_M, PRICE_OUT_PER_M) are set only on the
# connect lane / a targeted re-run / a chosen-model run, so the sed fallback reads them with
# \${VAR:-}: under set -u a bare \${VAR} would abort the apply on every other run.
if command -v envsubst >/dev/null 2>&1; then
  envsubst < /templates/review-agent.yaml.tmpl > /tmp/rendered.yaml
else
  sed -e "s|\\\${AGENT_NAME}|\${AGENT_NAME}|g" \\
      -e "s|\\\${PUBLISH_REQUEST_ID}|\${PUBLISH_REQUEST_ID}|g" \\
      -e "s|\\\${APP_SLUG}|\${APP_SLUG}|g" \\
      -e "s|\\\${BUNDLE_PRESIGNED_URL}|\${BUNDLE_PRESIGNED_URL}|g" \\
      -e "s|\\\${CALLBACK_URL}|\${CALLBACK_URL}|g" \\
      -e "s|\\\${CALLBACK_TOKEN}|\${CALLBACK_TOKEN}|g" \\
      -e "s|\\\${PRIOR_REPORT_JSON_B64}|\${PRIOR_REPORT_JSON_B64}|g" \\
      -e "s|\\\${COST_CAP_USD}|\${COST_CAP_USD}|g" \\
      -e "s|\\\${HOOKS_TOKEN}|\${HOOKS_TOKEN}|g" \\
      -e "s|\\\${AGENT_REVIEW_KIND}|\${AGENT_REVIEW_KIND:-}|g" \\
      -e "s|\\\${AGENT_REVIEW_SECTIONS}|\${AGENT_REVIEW_SECTIONS:-}|g" \\
      -e "s|\\\${ANALYSIS_MODEL}|\${ANALYSIS_MODEL:-}|g" \\
      -e "s|\\\${PRICE_IN_PER_M}|\${PRICE_IN_PER_M:-}|g" \\
      -e "s|\\\${PRICE_OUT_PER_M}|\${PRICE_OUT_PER_M:-}|g" \\
      /templates/review-agent.yaml.tmpl > /tmp/rendered.yaml
fi

# Do NOT cat /tmp/rendered.yaml — it contains the presigned URL + callback token.
echo "agent-review: rendered review-agent.yaml.tmpl for \${AGENT_NAME} (publish-request \${PUBLISH_REQUEST_ID})"

# ---- Idempotent re-dispatch --------------------------------------------------
# The rendered workload is now a Job, whose spec is largely IMMUTABLE, so a re-run
# for the SAME review can't just \`kubectl apply\` over an existing same-name Job
# (Deployments were apply-idempotent; Jobs are not). Delete any prior same-name
# review-agent Job first (its pod cascades); --ignore-not-found makes the first
# dispatch a no-op. --wait ensures the object is gone before apply recreates it.
kubectl delete job "\${AGENT_NAME}" -n ${ns} --ignore-not-found --wait=true
# ---- Apply the review-agent manifest into the namespace ---------------------
kubectl apply -f /tmp/rendered.yaml
echo "agent-review: applied objects for \${AGENT_NAME}"
`;
}

/**
 * Tear down an agent-review environment by label selector. Deletes the review-
 * agent Job(s) for a publish request (+ legacy Deployment(s)/Service(s) from
 * before the Deployment→Job switch, so a mid-transition teardown still cleans up).
 * Deleting a still-running Job cascades its pod, promptly stopping an analysis for
 * an already-decided review; a finished Job also self-reaps via
 * ttlSecondsAfterFinished, so this is belt-and-suspenders. Best-effort +
 * idempotent: 404s are ignored, and a single failed resource type does not abort
 * the rest. NEVER throws — called from the decision-path teardown hook.
 *
 * Selector: `civitai.com/role=review-agent,civitai.com/publish-request-id=<id>`.
 * Scoped to the publish request AND the review-agent role, so it can only ever
 * match this review's agent objects — never a live app (a live app carries no
 * `review-agent` role) and never the review-SANDBOX preview (role=... not
 * review-agent).
 */
export async function deleteAgentReviewResources(args: {
  slug: string;
  publishRequestId: string;
}): Promise<void> {
  // Build-only environments start no agent review Job, so there is nothing to tear down there.
  if (env.APPS_REVIEW_BUILD_ONLY) return;
  let target: Awaited<ReturnType<typeof getDp1Target>>;
  try {
    target = await getDp1Target();
  } catch (err) {
    // Not in-cluster / no SA token — nothing to tear down. Best-effort: swallow.
    // eslint-disable-next-line no-console
    console.warn(
      `[agent-review] deleteAgentReviewResources: no k8s target: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }
  const ns = env.APPS_KUBE_NAMESPACE;
  const selector = encodeURIComponent(
    `civitai.com/role=review-agent,civitai.com/publish-request-id=${args.publishRequestId}`
  );

  // LIST-then-DELETE-by-name (NOT deletecollection) so the feature needs only the
  // `list` + `delete` RBAC verbs — mirrors deleteReviewResources.
  const kinds: Array<{
    label: string;
    listPath: string;
    itemPath: (name: string) => string;
  }> = [
    {
      // The current rendered workload — delete with Background propagation so the
      // Job's pod cascades. (civitai-web already holds batch/jobs list+delete RBAC.)
      label: 'jobs',
      listPath: `/apis/batch/v1/namespaces/${ns}/jobs?labelSelector=${selector}`,
      itemPath: (name) => `/apis/batch/v1/namespaces/${ns}/jobs/${name}`,
    },
    {
      // Legacy — the pre-2026-07-27 review-agent was a Deployment. Kept so a
      // teardown that straddles the switch still sweeps an old object.
      label: 'deployments',
      listPath: `/apis/apps/v1/namespaces/${ns}/deployments?labelSelector=${selector}`,
      itemPath: (name) => `/apis/apps/v1/namespaces/${ns}/deployments/${name}`,
    },
    {
      // Legacy — the pre-2026-07-27 review-agent had a :18789 ClusterIP Service.
      label: 'services',
      listPath: `/api/v1/namespaces/${ns}/services?labelSelector=${selector}`,
      itemPath: (name) => `/api/v1/namespaces/${ns}/services/${name}`,
    },
  ];

  for (const k of kinds) {
    try {
      const listRes = await k8sFetch(target, k.listPath, { method: 'GET' });
      if (!listRes.ok) {
        if (listRes.status !== 404) {
          const body = await listRes.text().catch(() => '');
          // eslint-disable-next-line no-console
          console.warn(
            `[agent-review] deleteAgentReviewResources list ${k.label} ${
              listRes.status
            }: ${body.slice(0, 160)}`
          );
        }
        continue;
      }
      const list = await unwrap<{ items?: Array<{ metadata?: { name?: string } }> }>(listRes);
      const names = (list?.items ?? [])
        .map((it) => it?.metadata?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);

      for (const name of names) {
        try {
          const delRes = await k8sFetch(
            target,
            `${k.itemPath(name)}?propagationPolicy=Background`,
            { method: 'DELETE' }
          );
          if (!delRes.ok && delRes.status !== 404) {
            const body = await delRes.text().catch(() => '');
            // eslint-disable-next-line no-console
            console.warn(
              `[agent-review] deleteAgentReviewResources delete ${k.label}/${name} ${
                delRes.status
              }: ${body.slice(0, 160)}`
            );
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[agent-review] deleteAgentReviewResources delete ${k.label}/${name} threw: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agent-review] deleteAgentReviewResources ${k.label} threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
