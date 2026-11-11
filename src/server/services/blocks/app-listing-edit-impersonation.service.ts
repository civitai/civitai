import type { Prisma } from '@prisma/client';
import {
  callImpersonationModel,
  loadComparisonSet,
  runImpersonationChecks,
  type ModelCall,
} from './app-impersonation-check.service';
import { impersonationFingerprint, type ImpersonationSubject } from './app-impersonation.logic';
import type { ListingEditCheckSummary } from '~/shared/utils/agent-review-findings';

/**
 * The IMPERSONATION check on an APPROVED app's listing edit — the same check the agent review
 * runs on a code submission (`app-impersonation-check.service.ts`), applied to a listing
 * revision submitted for review (`submitListingRevision`).
 *
 * - It applies only when the edit changes the NAME, ICON or COVER (the identity a user sees).
 *   An edit that changes none of them is never checked and the queue shows what it always did.
 * - It is GATED on the same switches as the automatic agent review (the autostart flag and the
 *   agent-review flag's base value): off, nothing runs and no listing row is badged.
 * - It is REFUSED once the day's agent-review spend has reached the daily budget; the stored
 *   row then says `skipped` / `budget`, and the queue says so.
 * - At submit a `pending` row is written synchronously, before the model call starts in the
 *   background; the background run replaces it with the result. A pending, failed, skipped or
 *   MISSING row on an identity-changing edit badges the listing for a person to check by hand —
 *   a lost run never reads as "nothing to check".
 *
 * The result lives against the listing request (one `KeyValue` row, no schema change). A listing
 * revision is only ever applied on a moderator's approval; this puts the findings in front of
 * them, and an app whose listing edit hit is never in the fast lane. The model spend counts
 * against the daily agent-review budget (`recordListingCheckSpendUsd`). Never throws.
 */

const KEY_PREFIX = 'app-listing-edit-impersonation:';

export function listingEditCheckKey(publishRequestId: string): string {
  return `${KEY_PREFIX}${publishRequestId}`;
}

export type ListingIdentityField = 'name' | 'icon' | 'cover';

/** Which of the identity fields the revision changes, compared with the live listing. */
export function listingEditChanges(
  parent: { name: string; iconId: number | null; coverId: number | null },
  shadow: { name: string; iconId: number | null; coverId: number | null }
): ListingIdentityField[] {
  const changed: ListingIdentityField[] = [];
  if (shadow.name !== parent.name) changed.push('name');
  if (shadow.iconId !== parent.iconId) changed.push('icon');
  if (shadow.coverId !== parent.coverId) changed.push('cover');
  return changed;
}

/** Stored row. `status` is the top-level truth the queue reads. */
type StoredCheck = {
  status: 'pending' | 'skipped' | 'complete' | 'failed';
  reason?: string;
  changed: ListingIdentityField[];
  record?: unknown;
  findings?: unknown;
  costUsd?: number | null;
  /** What was judged: the revision's text, icon and cover under the PUBLIC slug. The queue
   *  recomputes it from the live revision; a mismatch means the result is stale. */
  fingerprint?: string;
};

/** The fingerprint of a revision as the listing-edit check judges it. */
function revisionFingerprint(
  shadow: {
    name: string;
    tagline: string | null;
    description: string | null;
    iconId: number | null;
    coverId: number | null;
  },
  publicSlug: string
): string {
  return impersonationFingerprint({
    name: shadow.name,
    slug: publicSlug,
    tagline: shadow.tagline ?? null,
    description: shadow.description ?? null,
    iconId: shadow.iconId ?? null,
    coverId: shadow.coverId ?? null,
  });
}

async function store(publishRequestId: string, check: StoredCheck): Promise<void> {
  const { dbWrite } = await import('~/server/db/client');
  const key = listingEditCheckKey(publishRequestId);
  const value = check as unknown as Prisma.InputJsonValue;
  await dbWrite.keyValue.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** The automatic agent review's switches — the listing-edit check follows the same pair. */
async function reviewAutomationOn(): Promise<boolean> {
  return (await import('~/server/services/app-blocks-flag')).isAgentReviewAutomationEnabled();
}

type EditTarget = {
  shadow: {
    id: string;
    name: string;
    tagline: string | null;
    description: string | null;
    iconId: number | null;
    coverId: number | null;
    icon: { url: string } | null;
    cover: { url: string } | null;
  };
  parent: { id: string; name: string; slug: string; userId: number };
  changed: ListingIdentityField[];
};

/**
 * The revision and the live listing it would replace, from the PRIMARY (this runs right after
 * the submit wrote the request). `null` when this is not a pending revision of an APPROVED
 * listing.
 */
async function loadEditTarget(publishRequestId: string): Promise<EditTarget | null> {
  const { dbWrite } = await import('~/server/db/client');
  const request = await dbWrite.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { id: true, appListingId: true, status: true },
  });
  if (!request?.appListingId || request.status !== 'pending') return null;
  const shadow = await dbWrite.appListing.findUnique({
    where: { id: request.appListingId },
    select: {
      id: true,
      name: true,
      tagline: true,
      description: true,
      iconId: true,
      coverId: true,
      revisionOfId: true,
      icon: { select: { url: true } },
      cover: { select: { url: true } },
    },
  });
  if (!shadow?.revisionOfId) return null;
  const parent = await dbWrite.appListing.findUnique({
    where: { id: shadow.revisionOfId },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      iconId: true,
      coverId: true,
      userId: true,
    },
  });
  if (!parent || parent.status !== 'approved') return null;
  return { shadow, parent, changed: listingEditChanges(parent, shadow) };
}

export type StartListingEditCheckOutcome =
  | 'disabled'
  | 'not-applicable'
  | 'unchanged'
  | 'skipped-budget'
  | 'started'
  | 'error';

export type ListingEditCheckGate = {
  featureOn: () => Promise<boolean>;
  spendTodayUsd: () => Promise<number>;
  dailyBudgetUsd: () => number | Promise<number>;
};

/**
 * Called from `submitListingRevision`, awaited (it is a few reads and one write; the model call
 * itself is started in the background). Never throws.
 */
export async function startListingEditImpersonationCheck(
  publishRequestId: string,
  deps: {
    gate?: Partial<ListingEditCheckGate>;
    run?: (publishRequestId: string) => Promise<unknown>;
  } = {}
): Promise<StartListingEditCheckOutcome> {
  try {
    const gate: ListingEditCheckGate = {
      featureOn: reviewAutomationOn,
      spendTodayUsd: async () =>
        (await import('./review-autodeploy.service')).agentReviewSpendTodayUsd(),
      dailyBudgetUsd: async () =>
        (await import('~/env/server')).env.AGENT_REVIEW_AUTOSTART_DAILY_BUDGET_USD,
      ...deps.gate,
    };
    const run = deps.run ?? ((id: string) => runListingEditImpersonationCheck(id));
    if (!(await gate.featureOn())) return 'disabled';
    const target = await loadEditTarget(publishRequestId);
    if (!target) return 'not-applicable';
    if (target.changed.length === 0) return 'unchanged';

    if ((await gate.spendTodayUsd()) >= (await gate.dailyBudgetUsd())) {
      await store(publishRequestId, {
        status: 'skipped',
        reason: 'budget',
        changed: target.changed,
      });
      return 'skipped-budget';
    }
    await store(publishRequestId, { status: 'pending', changed: target.changed });
    void run(publishRequestId).catch(() => undefined);
    return 'started';
  } catch (err) {
    warn(publishRequestId, err);
    return 'error';
  }
}

export type ListingEditCheckOutcome = 'checked' | 'unchanged' | 'not-applicable' | 'error';

/** The check itself (the background half). Replaces the pending row with the result. */
export async function runListingEditImpersonationCheck(
  publishRequestId: string,
  deps: { callModel?: ModelCall } = {}
): Promise<ListingEditCheckOutcome> {
  try {
    const callModel = deps.callModel ?? callImpersonationModel;
    const [{ dbWrite }, { listingIconUrl, listingCoverUrl }, { recordListingCheckSpendUsd }] =
      await Promise.all([
        import('~/server/db/client'),
        import('./listing-media-url'),
        import('./review-autodeploy.service'),
      ]);
    const target = await loadEditTarget(publishRequestId);
    if (!target) return 'not-applicable';
    const { shadow, parent, changed } = target;
    if (changed.length === 0) return 'unchanged';

    // The parent's fork link (not on the generated client types, so read raw as the fork
    // service does): a name matching the app it is a fork of is recorded, not flagged.
    const forkRows =
      (await dbWrite.$queryRaw`SELECT "fork_of_listing_id" AS "v" FROM "app_listings" WHERE "id" = ${parent.id}`) as
        | Array<{ v: string | null }>
        | undefined;
    const forkOfListingId =
      Array.isArray(forkRows) && typeof forkRows[0]?.v === 'string' ? forkRows[0].v : null;

    const subject: ImpersonationSubject = {
      name: shadow.name,
      // The PUBLIC slug: the shadow's own is a synthetic `rev-<ulid>` nobody sees.
      slug: parent.slug,
      tagline: shadow.tagline,
      description: shadow.description,
      forkOfListingId,
    };
    const result = await runImpersonationChecks(
      {
        subject,
        iconUrl: listingIconUrl(shadow.icon ?? null),
        coverUrl: listingCoverUrl(shadow.cover ?? null, null),
        ...(await loadComparisonSet(parent.userId)),
      },
      callModel
    );
    await store(publishRequestId, {
      status: result.record.status,
      changed,
      record: result.record,
      findings: result.findings,
      costUsd: result.costUsd,
      fingerprint: revisionFingerprint(shadow, parent.slug),
    });
    if (result.costUsd != null) await recordListingCheckSpendUsd(result.costUsd);
    return 'checked';
  } catch (err) {
    warn(publishRequestId, err);
    return 'error';
  }
}

function warn(publishRequestId: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[listing-edit-impersonation] failed (id=${publishRequestId}): ${
      err instanceof Error ? err.message : String(err)
    }`
  );
}

const NOT_FLAGGING = new Set(['low', 'info']);

/**
 * The queue's view of a stored check. Anything not recognisably one of the stored states reads
 * as FAILED — a person then checks the listing by hand — never as clear. A finding with no or an
 * unknown severity counts as flagging, like an unrated agent finding.
 */
export function summariseListingEditCheck(value: unknown): ListingEditCheckSummary {
  const o = (value && typeof value === 'object' ? value : {}) as {
    status?: unknown;
    record?: { status?: unknown };
    findings?: unknown;
  };
  const raw = o.status ?? o.record?.status;
  const status: ListingEditCheckSummary['status'] =
    raw === 'complete' || raw === 'pending' || raw === 'skipped' ? raw : 'failed';
  const findings = Array.isArray(o.findings) ? o.findings : [];
  const titles: string[] = [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const sev = String((f as { severity?: unknown }).severity ?? '').toLowerCase();
    if (NOT_FLAGGING.has(sev)) continue;
    const title = (f as { title?: unknown }).title;
    titles.push(typeof title === 'string' && title ? title.slice(0, 200) : 'Untitled finding');
  }
  return { status, flagging: titles.length, titles };
}

/**
 * The listing-edit check for one page of the listing queue, in two queries. A row appears only
 * for a pending revision of an APPROVED listing that changes its name, icon or cover, and only
 * while the review automation is on; such a row with no stored result reads as `missing` (a
 * person checks it by hand), never as "nothing to check".
 */
export async function listingEditQueueChecks(
  rows: Array<{ id: string; appListingId: string | null }>,
  deps: { featureOn?: () => Promise<boolean> } = {}
): Promise<Map<string, ListingEditCheckSummary>> {
  const out = new Map<string, ListingEditCheckSummary>();
  const withListing = rows.filter(
    (r): r is { id: string; appListingId: string } => !!r.appListingId
  );
  if (withListing.length === 0) return out;
  if (!(await (deps.featureOn ?? reviewAutomationOn)())) return out;
  const { dbRead } = await import('~/server/db/client');
  const shadows = (await dbRead.appListing.findMany({
    where: { id: { in: withListing.map((r) => r.appListingId) }, revisionOfId: { not: null } },
    select: {
      id: true,
      name: true,
      tagline: true,
      description: true,
      iconId: true,
      coverId: true,
      revisionOf: {
        select: { name: true, slug: true, iconId: true, coverId: true, status: true },
      },
    },
  })) as Array<{
    id: string;
    name: string;
    tagline?: string | null;
    description?: string | null;
    iconId: number | null;
    coverId: number | null;
    revisionOf: {
      name: string;
      slug?: string;
      iconId: number | null;
      coverId: number | null;
      status: string;
    } | null;
  }>;
  const shadowById = new Map(shadows.map((sh) => [sh.id, sh]));
  const identityEdit = new Set(
    shadows
      .filter(
        (s) => s.revisionOf?.status === 'approved' && listingEditChanges(s.revisionOf, s).length > 0
      )
      .map((s) => s.id)
  );
  const checked = withListing.filter((r) => identityEdit.has(r.appListingId));
  if (checked.length === 0) return out;
  const stored = await dbRead.keyValue.findMany({
    where: { key: { in: checked.map((r) => listingEditCheckKey(r.id)) } },
    select: { key: true, value: true },
  });
  const byId = new Map(stored.map((s) => [s.key.slice(KEY_PREFIX.length), s.value]));
  for (const r of checked) {
    const value = byId.get(r.id);
    if (value === undefined) {
      out.set(r.id, { status: 'missing', flagging: 0, titles: [] });
      continue;
    }
    const summary = summariseListingEditCheck(value);
    // A COMPLETE result is only good for the revision it judged: a pending revision stays
    // editable (its icon and cover can still change), so a different live revision → stale.
    const sh = shadowById.get(r.appListingId);
    const recorded = (value as { fingerprint?: unknown } | null)?.fingerprint;
    const live =
      sh && sh.revisionOf?.slug != null
        ? revisionFingerprint(
            {
              name: sh.name,
              tagline: sh.tagline ?? null,
              description: sh.description ?? null,
              iconId: sh.iconId,
              coverId: sh.coverId,
            },
            sh.revisionOf.slug
          )
        : null;
    out.set(
      r.id,
      summary.status === 'complete' && (typeof recorded !== 'string' || recorded !== live)
        ? { ...summary, status: 'stale' }
        : summary
    );
  }
  return out;
}
