import type { SessionUser } from '@civitai/auth';
import { getUserBanDetails, type BanDetailsMeta } from './ban';

// PURE derivation: queried rows + permissions → the @civitai/auth SessionUser. No DB / redis / env, so the
// parity-critical logic (tier ranking, allowAds, ban shaping, field mapping) is unit-testable in isolation.
// Mirrors the main app's getSessionUser body; session-producer.ts is the thin I/O wrapper (query → this →
// cache).

const TIER_ORDER: Record<string, number> = { founder: 5, gold: 4, silver: 3, bronze: 2, free: 1 };
const ACTIVE = ['active', 'trialing'];
const BAD_STATE = ['incomplete', 'past_due', 'unpaid'];

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export interface ProducerUserRow {
  id: number;
  username: string | null;
  email: string | null;
  emailVerified: Date | string | null;
  image: string | null;
  createdAt: Date | string | null;
  isModerator: boolean | null;
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  onboarding: number;
  muted: boolean;
  mutedAt: Date | string | null;
  bannedAt: Date | string | null;
  deletedAt: Date | string | null;
  customerId: string | null;
  paddleCustomerId: string | null;
  filePreferences: unknown;
  meta: unknown;
  profilePicture: { url: string } | null;
}

export interface ProducerSubscriptionRow {
  id: string;
  status: string;
  buzzType: string;
  product: { metadata: unknown } | null;
}

export interface ShapeSessionUserInput {
  row: ProducerUserRow;
  subscriptionRows: ProducerSubscriptionRow[];
  permissions: string[];
  /** `env.TIER_METADATA_KEY` — the `product.metadata` key holding the tier. Undefined → no tier resolved. */
  tierKey?: string;
}

export function shapeSessionUser({
  row,
  subscriptionRows,
  permissions,
  tierKey,
}: ShapeSessionUserInput): SessionUser {
  // tier / subscriptionsByBuzzType (mirrors the main app's loop).
  const subscriptions: Record<string, unknown> = {};
  let highestTier: string | undefined;
  let primarySubscriptionId: string | undefined;
  let memberInBadState = false;

  for (const sub of subscriptionRows) {
    const metadata = asObject(sub.product?.metadata);
    const tier = tierKey ? (metadata[tierKey] as string | undefined) : undefined;
    const isActive = ACTIVE.includes(sub.status);
    const isBadState = BAD_STATE.includes(sub.status);
    if (isBadState) memberInBadState = true;

    if (tier && tier !== 'free') {
      subscriptions[sub.buzzType] = {
        tier,
        isMember: isActive,
        subscriptionId: sub.id,
        status: sub.status,
      };
      if (isActive && (!highestTier || (TIER_ORDER[tier] ?? 0) > (TIER_ORDER[highestTier] ?? 0))) {
        highestTier = tier;
        primarySubscriptionId = sub.id;
      }
      if (isBadState && !primarySubscriptionId) primarySubscriptionId = sub.id;
    }
  }

  // allowAds / redBrowsingLevel — parity defaults (see the PARITY NOTE in session-producer.ts: the main
  // app's settings safeParse fails for ~all active users, so it falls through to these).
  const allowAds = highestTier != null ? false : true;
  const redBrowsingLevel: number | undefined = undefined;

  // meta → banDetails (parity: the main app strips banDetails out of meta before reading it, so banDetails
  // is effectively undefined; reproduced exactly).
  const fullMeta = asObject(row.meta) as { banDetails?: BanDetailsMeta } & Record<string, unknown>;
  const { banDetails: _strippedBanDetails, ...userMeta } = fullMeta;
  const banDetails = getUserBanDetails({ meta: userMeta as { banDetails?: BanDetailsMeta } });

  // Assemble the @civitai/auth SessionUser contract. Deliberately OMITTED vs the main app's cached entry:
  // name, autoplayGifs, leaderboardShowcase, referral — not in the frozen contract. Revisit at the cutover.
  return {
    id: row.id,
    username: row.username ?? undefined,
    email: row.email ?? undefined,
    emailVerified: row.emailVerified ? new Date(row.emailVerified) : undefined,
    image: row.profilePicture?.url ?? row.image ?? undefined,
    createdAt: row.createdAt ? new Date(row.createdAt) : undefined,
    isModerator: row.isModerator ?? undefined,
    muted: row.muted ?? undefined,
    mutedAt: row.mutedAt ? new Date(row.mutedAt) : undefined,
    bannedAt: row.bannedAt ? new Date(row.bannedAt) : undefined,
    deletedAt: row.deletedAt ? new Date(row.deletedAt) : undefined,
    showNsfw: row.showNsfw,
    blurNsfw: row.blurNsfw,
    browsingLevel: row.browsingLevel,
    redBrowsingLevel,
    onboarding: row.onboarding,
    permissions,
    customerId: row.customerId ?? undefined,
    paddleCustomerId: row.paddleCustomerId ?? undefined,
    subscriptionId: primarySubscriptionId,
    memberInBadState,
    allowAds,
    tier: highestTier,
    meta: userMeta,
    banDetails: banDetails as Record<string, unknown> | undefined,
    subscriptions,
    filePreferences: asObject(row.filePreferences),
  };
}
