import { playerBadge } from '$lib/player-badge';
import { civitaiSiteUrl } from '$lib/server/site-url';
import { imageUrl } from '$lib/server/image-url';
import { CONVERSION } from '$lib/server/conversion/config';
import { shopEnabled } from '$lib/server/conversion/runtime';
import { getDailyStatus } from '$lib/server/daily/daily.service';
import { db } from '$lib/server/db';
import { feedbackEnabled } from '$lib/server/feedback/enabled';
import { ladderRows } from '$lib/server/ladder';
import { PROGRESSION } from '$lib/server/progression/config';
import type { PlayerStatus } from '$lib/server/player-status';
import { requestPlayerStatus, requestStanding } from '$lib/server/request-reads';
import { queueDeps } from '$lib/server/queue/runtime';
import { rankBadgeUrls } from '$lib/server/rank-badges';
import { inquisitorQueueOpen } from '$lib/server/inquisitor/mode';
import { readUpdatesSeen } from '$lib/server/seen';
import { seenStore } from '$lib/server/seen-runtime';
import { unseenCount, updatesFor } from '$lib/server/whats-new/entries';
import type { Updates } from '$lib/updates';
import type { LayoutServerLoad } from './$types';

/** The most entries the dialog lists; older ones stay in the folder. */
const UPDATES_SHOWN = 6;

// The header's "What's new": the entries this player's rank can use, and how many they have not seen. Until the launch dialog
// is closed it shows instead, so nothing counts as unseen. A failed read only costs the dot.
function headerUpdates(
  rank: string,
  seen: Awaited<ReturnType<typeof readUpdatesSeen>>
): Updates | null {
  const entries = updatesFor(rank)
    .slice(0, UPDATES_SHOWN)
    .map(({ id, title, body, link }) => ({ id, title, body, link }));
  if (entries.length === 0) return null;
  return { entries, unseen: seen?.launchSeen ? unseenCount(entries, seen.updatesSeen) : 0 };
}

// The header's gold and rank pills and the streak chip, for every page. A page that loads its own `status`/`daily` overrides
// these in page data (play keeps its live copy); the rest get them here, so no page can forget the header's stats. A failed
// read only costs what failed: the pills when the status is gone, the streak alone when only the daily read failed.
async function headerStats(locals: App.Locals) {
  const playerId = locals.user.id;
  let status: PlayerStatus | null;
  try {
    status = await requestPlayerStatus(db, locals);
  } catch (error) {
    console.error('knights: could not read the header stats', { error });
    return { status: null, daily: null };
  }
  if (!status) return { status: null, daily: null };
  try {
    const daily = await getDailyStatus(db, {
      playerId,
      rank: status.rank,
      level: status.level,
      now: queueDeps.now(),
    });
    return { status, daily };
  } catch (error) {
    console.error('knights: could not read the header streak', { error });
    return { status, daily: null };
  }
}

// Muted players can't send feedback, so the flag alone doesn't open the control. The standing is read only when the flag is on.
async function feedbackOpen(
  user: NonNullable<App.Locals['user']>,
  locals: App.Locals
): Promise<boolean> {
  return (await feedbackEnabled(user)) && !(await requestStanding(db, locals)).muted;
}

// Not tied to the URL, so a client navigation keeps this data. It re-runs when something invalidates 'knights:header'
// (leaving /play, whose votes move the stats; closing "What's new") and after every form action and restart (`invalidateAll`).
const NO_BADGES: Awaited<ReturnType<typeof rankBadgeUrls>> = { small: {}, large: {} };

export const load: LayoutServerLoad = async ({ locals, depends }) => {
  depends('knights:header');
  const civitaiUrl = civitaiSiteUrl();
  const user = locals.user;
  const inquisitor = await inquisitorQueueOpen(user);
  const playerRow = user
    ? db
        .selectFrom('NewOrderPlayer')
        .select('userId')
        .where('userId', '=', user.id)
        .executeTakeFirst()
    : Promise.resolve(undefined);
  const [player, shopOpen, feedback, badges, header, seen] = await Promise.all([
    playerRow,
    shopEnabled(),
    user ? feedbackOpen(user, locals) : false,
    user ? rankBadgeUrls(db) : NO_BADGES,
    user && !inquisitor ? playerRow.then((row) => (row ? headerStats(locals) : null)) : null,
    user && !inquisitor ? readUpdatesSeen(seenStore, user.id) : null,
  ]);
  const rank = header?.status?.rank;
  return {
    civitaiUrl,
    // Keys the player's own sound setting in the browser; never shown.
    userId: user?.id ?? null,
    player: playerBadge(user, civitaiUrl, imageUrl),
    isPlayer: player !== undefined,
    shopOpen,
    feedbackOpen: feedback,
    // For the header's gold popover, the rank gauge popover and the rank badge on the avatar.
    goldPerBuzz: CONVERSION.goldPerBuzz,
    ladder: ladderRows(),
    // Fervor is a rolling window, not a calendar week; labels name its length.
    fervorWindowDays: PROGRESSION.fervorWindowDays,
    badges,
    inquisitor,
    updates: rank ? headerUpdates(rank, seen) : null,
    headerStats: header,
  };
};
