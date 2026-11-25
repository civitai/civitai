import { playerBadge } from '$lib/player-badge';
import { civitaiSiteUrl } from '$lib/server/site-url';
import { imageUrl } from '$lib/server/image-url';
import { CONVERSION } from '$lib/server/conversion/config';
import { shopEnabled } from '$lib/server/conversion/runtime';
import { getDailyStatus, getRecapState } from '$lib/server/daily/daily.service';
import { db } from '$lib/server/db';
import { feedbackEnabled } from '$lib/server/feedback/enabled';
import { ladderRows } from '$lib/server/ladder';
import { PROGRESSION } from '$lib/server/progression/config';
import type { PlayerStatus } from '$lib/server/player-status';
import { requestPlayerStatus, requestStanding } from '$lib/server/request-reads';
import { queueDeps } from '$lib/server/queue/runtime';
import { rankBadgeUrls } from '$lib/server/rank-badges';
import { inquisitorQueueOpen } from '$lib/server/inquisitor/mode';
import type { LayoutServerLoad } from './$types';

// The header's recap dot: a recap exists and has not been seen today, on the home card or in the header dialog (either one
// stores today's dismissal). The old popup opt-out no longer matters. The recap itself is read when the button is clicked, so a
// failure here only costs the dot.
async function recapUnseen(playerId: number | undefined): Promise<boolean> {
  if (playerId === undefined) return false;
  try {
    const state = await getRecapState(db, { playerId, now: queueDeps.now() });
    return state.hasHistory && !state.dismissedToday;
  } catch (error) {
    console.error('knights: could not read the recap state', { error });
    return false;
  }
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
// (leaving /play, whose votes move the stats) or 'app:recap', and after every form action and restart (`invalidateAll`).
const NO_BADGES: Awaited<ReturnType<typeof rankBadgeUrls>> = { small: {}, large: {} };

export const load: LayoutServerLoad = async ({ locals, depends }) => {
  depends('app:recap');
  depends('knights:header');
  const civitaiUrl = civitaiSiteUrl();
  const user = locals.user;
  // An Inquisitor's header shows neither the recap nor the player stats, so those reads are skipped.
  const inquisitor = await inquisitorQueueOpen(user);
  // Independent reads, sent together: this runs on every page load and after every form action.
  // Only a player has a career to restart (the account menu offers it) or header stats.
  const playerRow = user
    ? db
        .selectFrom('NewOrderPlayer')
        .select('userId')
        .where('userId', '=', user.id)
        .executeTakeFirst()
    : Promise.resolve(undefined);
  const [player, shopOpen, feedback, badges, recap, header] = await Promise.all([
    playerRow,
    shopEnabled(),
    user ? feedbackOpen(user, locals) : false,
    // A signed-out visitor (the welcome page, a 404) wears no badge, so the cosmetics are not read for them.
    user ? rankBadgeUrls(db) : NO_BADGES,
    inquisitor ? false : recapUnseen(user?.id),
    user && !inquisitor ? playerRow.then((row) => (row ? headerStats(locals) : null)) : null,
  ]);
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
    recapUnseen: recap,
    headerStats: header,
  };
};
