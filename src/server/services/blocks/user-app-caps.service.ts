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
  /** What `buzzPerDay` rises to after opting in: `OPT_IN_MULTIPLIER` times the plan's cap. */
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
  docBytes: 'apps.storage-bytes',
  docCount: 'apps.storage-docs',
} as const;

/**
 * Opting in to continue on your own Buzz raises the daily cap to this multiple of the viewer's
 * tier cap for the rest of the UTC day. Applied to the RESOLVED cap, so a cap override carries
 * through.
 */
export const OPT_IN_MULTIPLIER = 2;

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
    optInBuzzPerDay: planBuzzPerDay * OPT_IN_MULTIPLIER,
    docBytes: capFor(config, USER_APP_CAP_IDS.docBytes, tier),
    docCount: capFor(config, USER_APP_CAP_IDS.docCount, tier),
  };
}

/** The lowest value every cap takes across all tiers: what a failed user read serves. */
export function strictestPlanCaps(config: UsageLimitConfig): PlanCaps {
  const all = usageLimitTiers.map((tier) => planCapsForTier(config, tier));
  const min = (pick: (c: PlanCaps) => number) => Math.min(...all.map(pick));
  const planBuzzPerDay = min((c) => c.planBuzzPerDay);
  return {
    planBuzzPerDay,
    optInBuzzPerDay: planBuzzPerDay * OPT_IN_MULTIPLIER,
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
 * The plan caps of the user's tier, and the user (null when it could not be read, which serves
 * the strictest tier's caps). No opt-in lookup. Never throws: a failed config read serves the
 * code defaults.
 */
async function resolvePlan(
  userId: number,
  d: Required<UserAppCapsDeps>
): Promise<{ plan: PlanCaps; user: SessionUser | null }> {
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
  if (!user) return { plan: strictestPlanCaps(config), user: null };
  return { plan: planCapsForTier(config, user.tier), user };
}

/**
 * One user's app-platform caps: Buzz spent through apps per UTC day, and document storage per
 * app, from their membership tier (`SessionUser.tier`, the tier the account Limits section and
 * every other per-tier limit read). Per USER, not the per-APP `spendTier` caps in
 * `app-cap-limits.service.ts`.
 *
 * THE one source: the blocks router's daily Buzz reservation, the doc store's per-user ceiling
 * (through `docStoreUserLimits`, the same plan resolution without the opt-in) and the account
 * Limits section all read it, so what a user is shown is what is enforced
 * (`__tests__/user-app-caps.seam.test.ts` pins the callers). The per-tier values are the
 * `apps.*` entries of the usage-limit registry, overridable from the `usage-limits` KeyValue row.
 *
 * The opt-in is read record-first: one Redis GET, and the flag is evaluated only when a record
 * exists (one is written only while the flag is on), so a viewer who never opted in costs no
 * flag evaluation. With the flag since turned off, a record is ignored.
 *
 * Never throws. A failed config read serves the code defaults; a failed or empty user read
 * serves the strictest caps of any tier, with no opt-in; a failed opt-in read is "not opted in".
 */
export async function resolveUserAppCaps(
  userId: number,
  deps: UserAppCapsDeps = {}
): Promise<UserAppCaps> {
  const d = { ...defaults, ...deps };
  const { plan, user } = await resolvePlan(userId, d);
  let optedIn = false;
  if (user) {
    try {
      optedIn = (await d.readOptIn(userId)) && (await d.isOptInEnabled(user));
    } catch {
      optedIn = false;
    }
  }
  return { ...plan, buzzPerDay: optedIn ? plan.optInBuzzPerDay : plan.planBuzzPerDay, optedIn };
}

/**
 * The doc store's per-user ceiling (`DocStoreDeps.userLimits`): the same plan resolution as
 * `resolveUserAppCaps`, with no opt-in lookup at all (storage has no opt-in), so it makes no
 * Redis read and no flag evaluation.
 */
export async function docStoreUserLimits(
  userId: number,
  deps: UserAppCapsDeps = {}
): Promise<{ userBytes: number; userDocs: number }> {
  const { plan } = await resolvePlan(userId, { ...defaults, ...deps });
  return { userBytes: plan.docBytes, userDocs: plan.docCount };
}
