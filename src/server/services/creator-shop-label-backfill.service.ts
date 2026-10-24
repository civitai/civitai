import { dbWrite } from '~/server/db/client';
import {
  readShopListingStates,
  SHOP_VERDICT_TRANSACTION,
  shopLabelQuestion,
  shopLabelValue,
  shopVerdictSourceRef,
  writeShopLabel,
  type ShopListingState,
  type ShopVerdict,
  type ShopVerdictAction,
} from '~/server/services/creator-shop-labels.service';

// Records the verdicts already in `meta.history`, from before the live path wrote labels.

export type BackfillListing = ShopListingState & {
  status: string;
  reviewedById: number | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
};

export type PlannedLabel = { state: ShopListingState; verdict: ShopVerdict };

const REVIEW_ACTIONS = new Set<string>(['approve', 'request-changes', 'reject', 'revert']);

// A listing reviewed before the history log existed keeps only its last verdict's columns; its status
// says what that verdict was, unless something has moved the listing since.
const INFERRED_ACTION: Record<string, ShopVerdictAction> = {
  Published: 'approve',
  Rejected: 'reject',
  RequestedChanges: 'request-changes',
};

type Content = Pick<
  ShopListingState,
  'title' | 'description' | 'unitAmount' | 'availableQuantity'
> & {
  artworkKey: string | null;
};

const asNumber = (value: unknown) =>
  value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value);

function undoEdit(content: Content, changes: { field: string; from?: string | number | null }[]) {
  let artwork = false;
  for (const change of changes) {
    if (change.field === 'name') content.title = String(change.from ?? '');
    else if (change.field === 'description')
      content.description = change.from == null ? null : String(change.from);
    else if (change.field === 'artwork') {
      content.artworkKey = change.from == null ? null : String(change.from);
      artwork = true;
    } else if (change.field === 'price') content.unitAmount = asNumber(change.from) ?? 0;
    else if (change.field === 'quantity') content.availableQuantity = asNumber(change.from);
  }
  return artwork;
}

function stateAt(listing: ShopListingState, content: Content, artworkSwapped: boolean) {
  const state: ShopListingState = {
    ...listing,
    title: content.title,
    description: content.description,
    unitAmount: content.unitAmount,
    availableQuantity: content.availableQuantity,
  };
  if (artworkSwapped && listing.cosmetic) {
    const { imageHash, imageMeta, autoChecks, ...meta } = listing.meta ?? { purchases: 0 };
    state.meta = meta;
    state.cosmetic = { ...listing.cosmetic, artworkKey: content.artworkKey, pHashHex: null };
  }
  return state;
}

/**
 * The labels a listing's history holds, oldest first. Each verdict gets the content it judged, rebuilt
 * by undoing the edits recorded after it; a pack's membership is not versioned, so packs carry their
 * current members. A listing reviewed before the history log gets one inferred label.
 */
export function planShopLabelBackfill(listing: BackfillListing): PlannedLabel[] {
  const history = listing.meta?.history ?? [];
  const content: Content = {
    title: listing.title,
    description: listing.description,
    unitAmount: listing.unitAmount,
    availableQuantity: listing.availableQuantity,
    artworkKey: listing.cosmetic?.artworkKey ?? null,
  };
  let artworkSwapped = false;
  const planned: PlannedLabel[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.kind === 'edited') {
      if (undoEdit(content, entry.changes ?? [])) artworkSwapped = true;
      continue;
    }
    const action =
      entry.kind === 'takedown'
        ? 'takedown'
        : entry.kind === 'reviewed' && entry.action && REVIEW_ACTIONS.has(entry.action)
        ? (entry.action as ShopVerdictAction)
        : null;
    if (!action) continue;
    planned.push({
      state: stateAt(listing, content, artworkSwapped),
      verdict: {
        action,
        moderatorId: entry.userId,
        at: entry.at,
        note: entry.note,
        statusBefore: history[i - 1]?.status ?? null,
        statusAfter: entry.status ?? '',
        contentAt: 'reconstructed',
      },
    });
  }
  planned.reverse();

  const inferredAction = INFERRED_ACTION[listing.status];
  if (
    inferredAction &&
    listing.reviewedById != null &&
    listing.reviewedAt &&
    !history.some((entry) => entry.kind === 'reviewed')
  )
    planned.push({
      state: listing,
      verdict: {
        action: inferredAction,
        moderatorId: listing.reviewedById,
        at: listing.reviewedAt,
        note: inferredAction === 'approve' ? null : listing.rejectionReason,
        statusAfter: listing.status,
        contentAt: 'backfill',
        inferred: true,
      },
    });
  return planned;
}

const answerKey = ({ verdict }: PlannedLabel) =>
  `${shopLabelQuestion(verdict.action)}=${shopLabelValue(verdict.action)}`;

const tally = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * Plans (dry run) or records the backfill for listings after `afterId`. A dry run covers every listing;
 * a real run covers `limit` listings and returns `nextAfterId` while more remain. Inferred labels are
 * counted apart from the history's.
 */
export async function runShopLabelBackfill({
  dryRun,
  afterId,
  limit,
}: {
  dryRun: boolean;
  afterId: number;
  limit: number;
}) {
  const rows = await dbWrite.$queryRaw<
    {
      id: number;
      status: string;
      reviewedById: number | null;
      reviewedAt: Date | null;
      rejectionReason: string | null;
    }[]
  >`
    SELECT id, status::text, "reviewedById", "reviewedAt" AT TIME ZONE 'UTC' AS "reviewedAt",
      "rejectionReason"
    FROM "CosmeticShopItem"
    WHERE id > ${afterId}::int
      AND ("reviewedById" IS NOT NULL
        OR jsonb_path_exists(meta, '$.history[*] ? (@.kind == "reviewed" || @.kind == "takedown")'))
    ORDER BY id
    LIMIT ${dryRun ? null : limit}::int
  `;
  const states = new Map(
    (
      await readShopListingStates(
        dbWrite,
        rows.map((row) => row.id)
      )
    ).map((state) => [state.listingId, state])
  );

  let mysteryPacks = 0;
  const planned = rows.flatMap((row) => {
    const state = states.get(row.id);
    if (!state) return [];
    // Skipped: a pack's history doesn't say which edit a verdict judged, and logs automatic
    // send-backs as reviews. Only the live path labels packs.
    if (state.box) {
      mysteryPacks++;
      return [];
    }
    return planShopLabelBackfill({
      ...state,
      status: row.status,
      reviewedById: row.reviewedById,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      rejectionReason: row.rejectionReason,
    });
  });

  const refs = planned.map((label) => shopVerdictSourceRef(label.state.listingId, label.verdict));
  // An inferred verdict may be one the live path recorded whose history entry has since aged out of
  // the capped log: its live ref has the same listing, time and answer.
  const liveRefs = planned.map((label) =>
    label.verdict.inferred
      ? shopVerdictSourceRef(label.state.listingId, { ...label.verdict, inferred: false })
      : null
  );
  const lookup = [...refs, ...liveRefs.filter((ref): ref is string => ref !== null)];
  const existing = new Set(
    lookup.length
      ? (
          await dbWrite.$queryRaw<{ sourceRef: string }[]>`
            SELECT "sourceRef" FROM label_store.label WHERE "sourceRef" = ANY(${lookup}::text[])
          `
        ).map((row) => row.sourceRef)
      : []
  );
  const recordedAlready = (index: number) =>
    existing.has(refs[index]) || (liveRefs[index] !== null && existing.has(liveRefs[index]!));

  const fromHistory: Record<string, number> = {};
  const inferred: Record<string, number> = {};
  let alreadyRecorded = 0;
  let recorded = 0;
  let notRecorded = 0;
  for (const [index, label] of planned.entries()) {
    tally(label.verdict.inferred ? inferred : fromHistory, answerKey(label));
    if (recordedAlready(index)) {
      alreadyRecorded++;
      continue;
    }
    if (dryRun) continue;
    // The store logs a refused label to record_failure; count it as not recorded and move on.
    const added = await dbWrite
      .$transaction(
        (tx) => writeShopLabel(tx, label.state, label.verdict),
        SHOP_VERDICT_TRANSACTION
      )
      .catch(() => false);
    if (added) recorded++;
    else notRecorded++;
  }

  const lastId = rows.at(-1)?.id;
  return {
    dryRun,
    listings: rows.length,
    skippedMysteryPacks: mysteryPacks,
    fromHistory: { total: planned.length - sum(inferred), byAnswer: fromHistory },
    inferred: { total: sum(inferred), byAnswer: inferred },
    alreadyRecorded,
    recorded,
    notRecorded,
    nextAfterId: !dryRun && lastId != null && rows.length === limit ? lastId : null,
  };
}

const sum = (counts: Record<string, number>) =>
  Object.values(counts).reduce((total, n) => total + n, 0);
