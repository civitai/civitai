import { z } from 'zod';
import type { SessionUser } from '@civitai/auth';
import { getUserBanDetails, type BanDetailsMeta } from './ban';

// Focused parse of the two content-preference fields the session exposes off `User.settings`. The main app
// runs the FULL userSettingsSchema.safeParse (which fails wholesale if any unrelated field is mistyped, then
// falls back to defaults); we read just these two leniently so an explicit user choice is honored regardless
// of the rest of the blob. PARITY NOTE: this is intentionally more robust than getSessionUser — for the (rare)
// user whose settings blob has an unrelated malformed field AND an explicit allowAds/redBrowsingLevel, the hub
// honors it while getSessionUser currently defaults. To make them bit-identical, getSessionUser should adopt
// the same focused read (a small, revenue-adjacent change — left for explicit review). See the cutover doc (D).
const settingsSchema = z
  .object({ allowAds: z.boolean().optional(), redBrowsingLevel: z.number().optional() })
  .passthrough();

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
  name: string | null;
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
  autoplayGifs: boolean | null;
  leaderboardShowcase: string | null;
  filePreferences: unknown;
  settings: unknown;
  meta: unknown;
  profilePicture: { url: string } | null;
  referral: { id: number } | null;
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

  // allowAds / redBrowsingLevel — honor the user's stored settings when present (see settingsSchema note),
  // else fall back to the tier-based default (member → no ads; free → ads). Mirrors getSessionUser's intent.
  const parsedSettings = settingsSchema.safeParse(asObject(row.settings));
  const settings = parsedSettings.success ? parsedSettings.data : {};
  const allowAds = settings.allowAds != null ? settings.allowAds : highestTier != null ? false : true;
  const redBrowsingLevel: number | undefined =
    settings.redBrowsingLevel != null ? settings.redBrowsingLevel : undefined;

  // meta → banDetails (parity: the main app strips banDetails out of meta before reading it, so banDetails
  // is effectively undefined; reproduced exactly).
  const fullMeta = asObject(row.meta) as { banDetails?: BanDetailsMeta } & Record<string, unknown>;
  const { banDetails: _strippedBanDetails, ...userMeta } = fullMeta;
  const banDetails = getUserBanDetails({ meta: userMeta as { banDetails?: BanDetailsMeta } });

  // Assemble the @civitai/auth SessionUser contract — full parity with the main app's cached entry.
  return {
    id: row.id,
    username: row.username ?? undefined,
    name: row.name ?? undefined,
    autoplayGifs: row.autoplayGifs ?? undefined,
    leaderboardShowcase: row.leaderboardShowcase ?? undefined,
    referral: row.referral ?? undefined,
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
