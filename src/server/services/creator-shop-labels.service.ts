import { createHash } from 'crypto';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type { ReviewCreatorShopItemInput } from '~/server/schema/creator-shop.schema';
import { COSMETIC_PHASH_VERSION } from '~/server/services/cosmetic-phash.service';
import {
  LABEL_STATEMENT_TIMEOUT_MS,
  recordUnderSavepoint,
  type LabelStoreTx,
} from '~/server/services/label-store.service';
import { stableStringify } from '~/server/utils/entity-change-helpers';

// See docs/features/label-store.md.

export const CREATOR_SHOP_LABEL_FAMILY = 'creator_shop';
export const SHOP_REVIEW_QUESTION = 'creator_shop.listing.review';
export const SHOP_TAKEDOWN_QUESTION = 'creator_shop.listing.takedown';

// Must outlast the verdict's own writes (an approved mystery pack's are the slowest) plus up to four
// label statements, each capped at LABEL_STATEMENT_TIMEOUT_MS.
export const SHOP_VERDICT_TRANSACTION = {
  maxWait: 10_000,
  timeout: 10_000 + 4 * LABEL_STATEMENT_TIMEOUT_MS,
};

export type ShopVerdictAction = ReviewCreatorShopItemInput['action'] | 'takedown';

const VALUES: Record<ShopVerdictAction, string> = {
  approve: 'approve',
  'request-changes': 'request_changes',
  reject: 'reject',
  revert: 'revert',
  takedown: 'takedown',
};

export type ShopLabelSubjectType = 'shop_cosmetic' | 'shop_pack' | 'shop_mystery_pack';

/** What a moderator saw: the listing and, by kind, its cosmetic, pack members or box. */
export type ShopListingState = {
  listingId: number;
  title: string;
  description: string | null;
  unitAmount: number;
  availableQuantity: number | null;
  meta: CosmeticShopItemMeta | null;
  addedById: number | null;
  cosmetic: {
    id: number;
    type: string;
    artworkKey: string | null;
    createdById: number | null;
    /** Only when it was computed from `artworkKey` with the current algorithm. */
    pHashHex: string | null;
  } | null;
  /** A pack's members, in pack order. */
  members: { cosmeticId: number; artworkKey: string | null }[];
  box: {
    id: number;
    sellerId: number;
    version: number;
    imageUrl: string | null;
  } | null;
  /** The mystery-pack edit the verdict was on. */
  revision: { id: number; baseVersion: number; proposal: unknown } | null;
};

export type ShopVerdict = {
  action: ShopVerdictAction;
  moderatorId: number;
  /** The `at` of the verdict's history entry; part of the source ref. */
  at: string;
  note?: string | null;
  statusBefore?: string | null;
  statusAfter: string;
  finalReject?: boolean;
};

export const shopLabelQuestion = (action: ShopVerdictAction) =>
  action === 'takedown' ? SHOP_TAKEDOWN_QUESTION : SHOP_REVIEW_QUESTION;

export const shopLabelValue = (action: ShopVerdictAction) => VALUES[action];

/** Keyed on the verdict's history entry `at` and its answer; labels backfilled from history carry the same refs, so the shape must not change. */
export function shopVerdictSourceRef(listingId: number, verdict: ShopVerdict) {
  if (verdict.action === 'takedown') return `CreatorShopTakedown:${listingId}:${verdict.at}`;
  return `CreatorShopReview:${listingId}:${verdict.at}:${shopLabelValue(verdict.action)}`;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The subject a verdict is about. Price, quantity and resale terms are not part of the content: a price-only re-review judges the same art and text. */
export function shopLabelSubject(state: ShopListingState) {
  const coverKey = state.meta?.coverUrl ?? null;
  let subjectType: ShopLabelSubjectType;
  let content: Record<string, unknown>;
  let ownerId: number | null;
  let artworkKey: string | null;
  if (state.box) {
    subjectType = 'shop_mystery_pack';
    ownerId = state.box.sellerId;
    artworkKey = coverKey ?? state.box.imageUrl;
    content = state.revision
      ? {
          v: 1,
          title: state.title,
          description: state.description,
          proposal: state.revision.proposal,
        }
      : { v: 1, title: state.title, description: state.description, boxVersion: state.box.version };
  } else if (state.cosmetic) {
    subjectType = 'shop_cosmetic';
    ownerId = state.cosmetic.createdById ?? state.addedById;
    artworkKey = state.cosmetic.artworkKey;
    content = {
      v: 1,
      type: state.cosmetic.type,
      artworkKey,
      title: state.title,
      description: state.description,
    };
  } else {
    subjectType = 'shop_pack';
    ownerId = state.addedById;
    artworkKey = coverKey;
    content = {
      v: 1,
      title: state.title,
      description: state.description,
      coverKey,
      members: state.members,
    };
  }
  return {
    subjectType,
    subjectId: String(state.listingId),
    contentHash: sha256(stableStringify(content)),
    ownerId,
    // A reader fetches the stored original by this ref, never the public url: a takedown stops that.
    bytesRef: artworkKey ? `cf-image:${artworkKey}` : null,
  };
}

function queuedAt(meta: CosmeticShopItemMeta | null, at: string) {
  const history = meta?.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.at < at && (entry.kind === 'submitted' || entry.kind === 'edited')) return entry.at;
  }
  return null;
}

export function shopLabelSnapshot(state: ShopListingState, verdict: ShopVerdict) {
  const meta = state.meta;
  const { subjectType } = shopLabelSubject(state);
  return {
    v: 1,
    kind: subjectType,
    // Backfilled labels carry `reconstructed` or `backfill` here.
    contentAt: 'verdict',
    listingId: state.listingId,
    title: state.title,
    description: state.description,
    unitAmount: state.unitAmount,
    availableQuantity: state.availableQuantity,
    sellableByOthers: meta?.sellableByOthers ?? null,
    sellerShare: meta?.sellerShare ?? null,
    acceptsBlueBuzz: meta?.acceptsBlueBuzz ?? null,
    rightsAffirmed: !!meta?.rightsAffirmation,
    statusBefore: verdict.statusBefore ?? null,
    statusAfter: verdict.statusAfter,
    submittedAt: meta?.history?.find((entry) => entry.kind === 'submitted')?.at ?? null,
    queuedAt: queuedAt(meta, verdict.at),
    ...(verdict.finalReject !== undefined ? { finalReject: verdict.finalReject } : {}),
    ...(state.cosmetic
      ? {
          cosmeticId: state.cosmetic.id,
          cosmeticType: state.cosmetic.type,
          artworkKey: state.cosmetic.artworkKey,
          imageHash: meta?.imageHash ?? null,
          imageMeta: meta?.imageMeta ?? null,
          autoChecks: meta?.autoChecks ?? null,
          pHashHex: state.cosmetic.pHashHex,
          pHashVersion: state.cosmetic.pHashHex ? COSMETIC_PHASH_VERSION : null,
        }
      : {}),
    ...(state.box
      ? {
          boxId: state.box.id,
          boxVersion: state.box.version,
          boxRevisionId: state.revision?.id ?? null,
          proposal: state.revision?.proposal ?? null,
        }
      : {}),
    ...(!state.cosmetic && !state.box
      ? { coverKey: meta?.coverUrl ?? null, members: state.members }
      : {}),
  };
}

/** Records the label, then points its subject at the artwork. */
export async function writeShopLabel(
  tx: LabelStoreTx,
  state: ShopListingState,
  verdict: ShopVerdict
) {
  const subject = shopLabelSubject(state);
  const snapshot = shopLabelSnapshot(state, verdict);
  const [row] = await tx.$queryRaw<{ id: bigint | number | null }[]>`
    SELECT label_store.record_label(
      p_subject_type => ${subject.subjectType}::text,
      p_subject_id => ${subject.subjectId}::text,
      p_content_hash => ${subject.contentHash}::text,
      p_family => ${CREATOR_SHOP_LABEL_FAMILY}::text,
      p_question => ${shopLabelQuestion(verdict.action)}::text,
      p_value => ${shopLabelValue(verdict.action)}::text,
      p_labeller_kind => 'moderator',
      p_labeller_user_id => ${verdict.moderatorId}::int,
      p_source_ref => ${shopVerdictSourceRef(state.listingId, verdict)}::text,
      p_labelled_at => ${verdict.at}::timestamptz,
      p_reason_note => ${verdict.note || null}::text,
      p_snapshot => ${JSON.stringify(snapshot)}::jsonb,
      p_owner_user_id => ${subject.ownerId}::int
    ) AS id
  `;
  const recorded = row?.id != null;
  if (recorded && subject.bytesRef)
    await tx.$queryRaw`
      SELECT label_store.attach_bytes(
        ${subject.subjectType}::text, ${subject.subjectId}::text, ${subject.contentHash}::text,
        ${subject.bytesRef}::text
      )
    `;
  return recorded;
}

type ListingRow = {
  id: number;
  title: string;
  description: string | null;
  unitAmount: number;
  availableQuantity: number | null;
  meta: CosmeticShopItemMeta | null;
  addedById: number | null;
  cosmeticId: number | null;
  cosmeticType: string | null;
  artworkKey: string | null;
  createdById: number | null;
  pHashHex: string | null;
  boxId: number | null;
  sellerId: number | null;
  boxVersion: number | null;
  boxImageUrl: string | null;
  members: { cosmeticId: number; artworkKey: string | null }[];
};

export async function readShopListingStates(tx: LabelStoreTx, listingIds: number[]) {
  if (!listingIds.length) return [];
  const rows = await tx.$queryRaw<ListingRow[]>`
    SELECT s.id, s.title, s.description, s."unitAmount", s."availableQuantity", s.meta, s."addedById",
      c.id AS "cosmeticId", c.type::text AS "cosmeticType", c.data->>'url' AS "artworkKey",
      c."createdById",
      CASE WHEN c."pHashUrl" = c.data->>'url' AND c."pHashVersion" = ${COSMETIC_PHASH_VERSION}
        THEN c."pHashHex" END AS "pHashHex",
      d.id AS "boxId", d."sellerId", d.version AS "boxVersion", d."imageUrl" AS "boxImageUrl",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('cosmeticId', m."cosmeticId", 'artworkKey', mc.data->>'url')
          ORDER BY m.index, m."cosmeticId")
        FROM "CosmeticShopItemCosmetic" m JOIN "Cosmetic" mc ON mc.id = m."cosmeticId"
        WHERE m."shopItemId" = s.id
      ), '[]'::jsonb) AS members
    FROM "CosmeticShopItem" s
    LEFT JOIN "Cosmetic" c ON c.id = s."cosmeticId"
    LEFT JOIN "ItemDefinition" d ON d.id = s."itemDefinitionId" AND d."sellerId" IS NOT NULL
    WHERE s.id = ANY(${listingIds}::int[])
  `;
  return rows.map(
    (row): ShopListingState => ({
      listingId: row.id,
      title: row.title,
      description: row.description,
      unitAmount: row.unitAmount,
      availableQuantity: row.availableQuantity,
      meta: row.meta,
      addedById: row.addedById,
      cosmetic:
        row.cosmeticId != null
          ? {
              id: row.cosmeticId,
              type: row.cosmeticType ?? '',
              artworkKey: row.artworkKey,
              createdById: row.createdById,
              pHashHex: row.pHashHex,
            }
          : null,
      members: row.members,
      box:
        row.boxId != null && row.sellerId != null
          ? {
              id: row.boxId,
              sellerId: row.sellerId,
              version: row.boxVersion ?? 1,
              imageUrl: row.boxImageUrl,
            }
          : null,
      revision: null,
    })
  );
}

async function readRevision(tx: LabelStoreTx, revisionId: number) {
  const [row] = await tx.$queryRaw<{ id: number; baseVersion: number; proposal: unknown }[]>`
    SELECT id, "baseVersion", proposal FROM "BoxRevision" WHERE id = ${revisionId}::int
  `;
  return row ?? null;
}

async function writeVerdictLabel(
  tx: LabelStoreTx,
  listingId: number,
  verdict: ShopVerdict,
  revisionId?: number | null
) {
  const [state] = await readShopListingStates(tx, [listingId]);
  if (!state) return false;
  if (revisionId != null) state.revision = await readRevision(tx, revisionId);
  return writeShopLabel(tx, state, verdict);
}

const logVerdictNotRecorded = (listingId: number, action: ShopVerdictAction) => (error: unknown) =>
  logToAxiom({
    type: 'error',
    name: 'creator-shop',
    message: 'review verdict not recorded as a label',
    shopItemId: listingId,
    action,
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => null);

/**
 * Records a moderator's verdict on a listing as a label, inside the verdict's transaction and after its
 * write, so the label sees what the verdict left. Must be the transaction's last step (see
 * `recordUnderSavepoint`); a failed label never fails the verdict.
 */
export function recordShopVerdict(
  tx: LabelStoreTx,
  listingId: number,
  verdict: ShopVerdict,
  revisionId?: number | null
) {
  return recordUnderSavepoint(
    tx,
    () => writeVerdictLabel(tx, listingId, verdict, revisionId),
    logVerdictNotRecorded(listingId, verdict.action)
  );
}

/**
 * A takedown's label, in its own transaction once the takedown is done: a label must not hold up or
 * fail the money path. Never throws; any failure logs `shop-label-record-failed` for alerting.
 */
export async function recordShopTakedownLabel(
  listingId: number,
  verdict: Omit<ShopVerdict, 'action'>
) {
  const takedown = { ...verdict, action: 'takedown' as const };
  let failed = false;
  await dbWrite
    .$transaction(
      (tx) =>
        recordUnderSavepoint(
          tx,
          () => writeVerdictLabel(tx, listingId, takedown),
          (error) => {
            failed = true;
            logVerdictNotRecorded(listingId, 'takedown')(error);
          }
        ),
      SHOP_VERDICT_TRANSACTION
    )
    .catch(() => {
      failed = true;
    });
  if (failed)
    await logToAxiom({ type: 'error', name: 'shop-label-record-failed', itemId: listingId }).catch(
      () => null
    );
}

/** Takes a deleted listing's subjects out of training: judgements stay, content goes. */
export function excludeDeletedShopListing(tx: LabelStoreTx, listingId: number) {
  return recordUnderSavepoint(
    tx,
    async () => {
      for (const subjectType of ['shop_cosmetic', 'shop_pack', 'shop_mystery_pack'])
        await tx.$queryRaw`
          SELECT label_store.exclude(${subjectType}::text, ${String(listingId)}::text, 'removed')
        `;
      return true;
    },
    (error) =>
      logToAxiom({
        type: 'error',
        name: 'creator-shop',
        message: 'deleted listing not excluded from the label store',
        shopItemId: listingId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => null)
  );
}
