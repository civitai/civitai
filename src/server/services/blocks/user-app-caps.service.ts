import type { SessionUser } from '~/types/session';
import type { UsageLimitConfig } from '~/shared/constants/usage-limits';
import {
  defaultUsageLimitConfig,
  getUsageLimitDef,
  resolveUsageLimitValues,
  usageLimitTiers,
} from '~/shared/constants/usage-limits';

export type UserAppCaps = {
  /** The daily app Buzz cap enforced now: the plan's, or `optInBuzzPerDay` once opted in today. */
  buzzPerDay: number;
  /** The daily app Buzz cap of the viewer's membership tier. */
  planBuzzPerDay: number;
  /** What `buzzPerDay` rises to after opting in; equal to `planBuzzPerDay` when nothing to opt in to. */
  optInBuzzPerDay: number;
  /** Whether the viewer opted in to continue on their own Buzz for this UTC day. */
  optedIn: boolean;
  /** Storage one user may hold in one app. */
  docBytes: number;
  docCount: number;
};

/** The registry entries (`usage-limits.ts`) that hold the per-tier values. */
export const USER_APP_CAP_IDS = {
  buzzPerDay: 'apps.buzz-daily',
  optInBuzzPerDay: 'apps.buzz-daily-opt-in',
  docBytes: 'apps.storage-bytes',
  docCount: 'apps.storage-docs',
} as const;

type PlanCaps = Omit<UserAppCaps, 'buzzPerDay' | 'optedIn'>;

/**
 * One cap for one tier under `config`. Only the tier rule applies: these entries carry no Creator
 * Score tiers, and `disabled` is ignored (the registry refuses it for these entries anyway), so a
 * cap is always a number.
 */
function capFor(config: UsageLimitConfig, id: string, tier: string | null | undefined): number {
  const values = config.get(id) ?? getUsageLimitDef(id);
  return resolveUsageLimitValues(values, { tier }).limit;
}

/** The plan caps of `tier` (no tier, or an unknown one, reads as free). Pure. */
export function planCapsForTier(
  config: UsageLimitConfig,
  tier: string | null | undefined
): PlanCaps {
  const planBuzzPerDay = capFor(config, USER_APP_CAP_IDS.buzzPerDay, tier);
  return {
    planBuzzPerDay,
    // Opting in can only ever widen: a ceiling set below the plan's cap gives nothing to opt in to.
    optInBuzzPerDay: Math.max(
      planBuzzPerDay,
      capFor(config, USER_APP_CAP_IDS.optInBuzzPerDay, tier)
    ),
    docBytes: capFor(config, USER_APP_CAP_IDS.docBytes, tier),
    docCount: capFor(config, USER_APP_CAP_IDS.docCount, tier),
  };
}

/** The lowest value every cap takes across all tiers, with no opt-in: what a failure serves. */
export function strictestUserAppCaps(config: UsageLimitConfig): UserAppCaps {
  const all = usageLimitTiers.map((tier) => planCapsForTier(config, tier));
  const min = (pick: (c: PlanCaps) => number) => Math.min(...all.map(pick));
  const planBuzzPerDay = min((c) => c.planBuzzPerDay);
  return {
    buzzPerDay: planBuzzPerDay,
    planBuzzPerDay,
    optInBuzzPerDay: planBuzzPerDay,
    optedIn: false,
    docBytes: min((c) => c.docBytes),
    docCount: min((c) => c.docCount),
  };
}

export type UserAppCapsDeps = {
  getConfig?: () => Promise<UsageLimitConfig>;
  /** The user's session, whose `tier` is the membership tier every per-tier limit reads. */
  getSessionUser?: (userId: number) => Promise<SessionUser | null>;
  isOptInEnabled?: (user: SessionUser) => Promise<boolean>;
  readOptIn?: (userId: number) => Promise<boolean>;
};

const defaults: Required<UserAppCapsDeps> = {
  getConfig: async () =>
    (await import('~/server/services/usage-limit-config.service')).getUsageLimitConfig(),
  getSessionUser: async (userId) =>
    ((await (
      await import('~/server/auth/session-client')
    ).sessionClient.getSessionUserById(userId)) as SessionUser | null) ?? null,
  isOptInEnabled: async (user) =>
    (await import('~/server/services/app-blocks-flag')).isAppLimitsUpgradePromptEnabled({ user }),
  readOptIn: async (userId) => {
    const [{ sysRedis }, { buzzOptInRedisKey }] = await Promise.all([
      import('~/server/redis/client'),
      import('~/server/services/blocks/block-buzz-cap'),
    ]);
    return (await sysRedis.get(buzzOptInRedisKey(userId))) === '1';
  },
};

/**
 * One user's app-platform caps: Buzz spent through apps per UTC day, and document storage per
 * app, from their membership tier (`SessionUser.tier`, the tier the account Limits section and
 * every other per-tier limit read). Per USER, not the per-APP `spendTier` caps in
 * `app-cap-limits.service.ts`.
 *
 * THE one source: the blocks router's daily Buzz reservation, the doc store's per-user ceiling
 * and the account Limits section all read it, so what a user is shown is what is enforced
 * (`__tests__/user-app-caps.seam.test.ts` pins the callers). The per-tier values are the
 * `apps.*` entries of the usage-limit registry, overridable from the `usage-limits` KeyValue row.
 *
 * Never throws. A failed config read serves the code defaults; a failed or empty user read
 * serves the strictest caps of any tier, with no opt-in; a failed opt-in read is "not opted in".
 */
export async function resolveUserAppCaps(
  userId: number,
  deps: UserAppCapsDeps = {}
): Promise<UserAppCaps> {
  const d = { ...defaults, ...deps };
  let config: UsageLimitConfig = defaultUsageLimitConfig;
  try {
    config = await d.getConfig();
  } catch {
    config = defaultUsageLimitConfig;
  }
  let user: SessionUser | null;
  try {
    user = await d.getSessionUser(userId);
  } catch {
    user = null;
  }
  if (!user) return strictestUserAppCaps(config);

  const plan = planCapsForTier(config, user.tier);
  let optedIn = false;
  // No flag read and no Redis read while there is nothing to opt in to: then this is exactly the
  // plan's cap, whatever was recorded.
  if (plan.optInBuzzPerDay > plan.planBuzzPerDay) {
    try {
      optedIn = (await d.isOptInEnabled(user)) && (await d.readOptIn(userId));
    } catch {
      optedIn = false;
    }
  }
  return { ...plan, buzzPerDay: optedIn ? plan.optInBuzzPerDay : plan.planBuzzPerDay, optedIn };
}

/** The doc store's per-user ceiling (`DocStoreDeps.userLimits`), from the same resolver. */
export async function docStoreUserLimits(
  userId: number
): Promise<{ userBytes: number; userDocs: number }> {
  const caps = await resolveUserAppCaps(userId);
  return { userBytes: caps.docBytes, userDocs: caps.docCount };
}
