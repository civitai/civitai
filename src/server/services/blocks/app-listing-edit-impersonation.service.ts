import type { Prisma } from '@prisma/client';
import {
  callImpersonationModel,
  loadComparisonSet,
  runImpersonationChecks,
  type ModelCall,
} from './app-impersonation-check.service';
import type { ImpersonationSubject } from './app-impersonation.logic';
import type { ListingEditCheckSummary } from '~/shared/utils/agent-review-findings';

/**
 * The IMPERSONATION check on an APPROVED app's listing edit — the same check the agent review
 * runs on a code submission (`app-impersonation-check.service.ts`), applied to a listing
 * revision submitted for review (`submitListingRevision`).
 *
 * It runs only when the edit changes the NAME, ICON or COVER (the identity a user sees). An edit
 * that changes none of them is not checked, and the queue shows exactly what it showed before.
 * The result is stored against the listing request (one `KeyValue` row, no schema change) and
 * the moderator queue badges a hit or an incomplete check, so the edit is read by a person with
 * the findings in front of them — a listing revision is never applied without a moderator's
 * approval anyway, and an app whose listing edit hit is never in the fast lane. The model spend
 * counts against the daily agent-review budget (`recordListingCheckSpendUsd`). Never throws.
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

export type ListingEditCheckOutcome = 'checked' | 'unchanged' | 'not-applicable' | 'error';

export async function runListingEditImpersonationCheck(
  publishRequestId: string,
  deps: { callModel?: ModelCall } = {}
): Promise<ListingEditCheckOutcome> {
  try {
    const callModel = deps.callModel ?? callImpersonationModel;
    const [
      { dbRead, dbWrite },
      { listingIconUrl, listingCoverUrl },
      { recordListingCheckSpendUsd },
    ] = await Promise.all([
      import('~/server/db/client'),
      import('./listing-media-url'),
      import('./review-autodeploy.service'),
    ]);
    const request = await dbRead.appListingPublishRequest.findUnique({
      where: { id: publishRequestId },
      select: { id: true, appListingId: true, status: true },
    });
    if (!request?.appListingId || request.status !== 'pending') return 'not-applicable';

    const shadow = await dbRead.appListing.findUnique({
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
    if (!shadow?.revisionOfId) return 'not-applicable';
    const parent = await dbRead.appListing.findUnique({
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
    if (!parent || parent.status !== 'approved') return 'not-applicable';

    const changed = listingEditChanges(parent, shadow);
    if (changed.length === 0) return 'unchanged';

    // The parent's fork link (not on the generated client types, so read raw as the fork
    // service does): a name matching the app it is a fork of is recorded, not flagged.
    const forkRows =
      (await dbRead.$queryRaw`SELECT "fork_of_listing_id" AS "v" FROM "app_listings" WHERE "id" = ${parent.id}`) as
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

    const value = {
      changed,
      record: result.record,
      findings: result.findings,
      costUsd: result.costUsd,
    } as unknown as Prisma.InputJsonValue;
    const key = listingEditCheckKey(publishRequestId);
    await dbWrite.keyValue.upsert({ where: { key }, create: { key, value }, update: { value } });
    if (result.costUsd != null) await recordListingCheckSpendUsd(result.costUsd);
    return 'checked';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[listing-edit-impersonation] failed (id=${publishRequestId}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return 'error';
  }
}

const FLAGGING = new Set(['critical', 'high', 'medium']);

/**
 * The queue's view of a stored check. Anything not recognisably a complete record reads as
 * FAILED — a person then checks the listing by hand — never as clear.
 */
export function summariseListingEditCheck(value: unknown): ListingEditCheckSummary {
  const o = (value && typeof value === 'object' ? value : {}) as {
    record?: { status?: unknown };
    findings?: unknown;
  };
  const status = o.record?.status === 'complete' ? 'complete' : 'failed';
  const findings = Array.isArray(o.findings) ? o.findings : [];
  const titles: string[] = [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const sev = String((f as { severity?: unknown }).severity ?? '').toLowerCase();
    if (!FLAGGING.has(sev)) continue;
    const title = (f as { title?: unknown }).title;
    titles.push(typeof title === 'string' ? title.slice(0, 200) : 'impersonation finding');
  }
  return { status, flagging: titles.length, titles };
}

/** The stored checks for one page of listing requests, in one query. Absent = never checked. */
export async function listingEditCheckSummaries(
  publishRequestIds: string[]
): Promise<Map<string, ListingEditCheckSummary>> {
  const out = new Map<string, ListingEditCheckSummary>();
  if (publishRequestIds.length === 0) return out;
  const { dbRead } = await import('~/server/db/client');
  const rows = await dbRead.keyValue.findMany({
    where: { key: { in: publishRequestIds.map(listingEditCheckKey) } },
    select: { key: true, value: true },
  });
  for (const r of rows) out.set(r.key.slice(KEY_PREFIX.length), summariseListingEditCheck(r.value));
  return out;
}
