/**
 * The Forgejo orgs App Blocks writes to — the ONE place their names are decided.
 *
 *   apps    canonical per-app repos the build pipeline clones (`civitai-apps/<slug>`); the only
 *           org the git-push webhook accepts (`parseExpectedRepo` in `git-push.ts`)
 *   review  disposable in-review snapshots of a submission (`civitai-apps-review/<slug>`)
 *   source  the developer's own git history of a fork or App Assistant app (`civitai-apps-src/<slug>`)
 *
 * Production sets none of `FORGEJO_APPS_ORG` / `FORGEJO_REVIEW_ORG` / `FORGEJO_SRC_ORG` and gets
 * the names above. A PR preview runs unmerged code with a bot token that can write only its own
 * preview orgs, so it sets all three to those. The rules below make a half-configured or
 * mis-configured environment refuse every Forgejo call rather than write somewhere unexpected:
 *
 *   - all three set, or none (a mix would send one flow to a production org);
 *   - each a valid Forgejo org name;
 *   - pairwise distinct (the build and review flows both key repos by slug, so a shared org
 *     would make a review snapshot overwrite the canonical repo of the same slug);
 *   - none equal to a production org name.
 *
 * On a violation `error` is set and `forgejo.service.ts` refuses every request with it.
 */

import { env } from '~/env/server';

export const PRODUCTION_FORGEJO_ORGS = {
  apps: 'civitai-apps',
  review: 'civitai-apps-review',
  source: 'civitai-apps-src',
} as const;

export type ForgejoOrgs = {
  apps: string;
  review: string;
  source: string;
  /** Why the configuration was refused; every Forgejo call throws it. `null` when usable. */
  error: string | null;
};

type OrgEnv = {
  FORGEJO_APPS_ORG?: string;
  FORGEJO_REVIEW_ORG?: string;
  FORGEJO_SRC_ORG?: string;
};

const ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const PRODUCTION_NAMES: readonly string[] = Object.values(PRODUCTION_FORGEJO_ORGS);

export function resolveForgejoOrgs(e: OrgEnv): ForgejoOrgs {
  const set = {
    FORGEJO_APPS_ORG: e.FORGEJO_APPS_ORG?.trim() || undefined,
    FORGEJO_REVIEW_ORG: e.FORGEJO_REVIEW_ORG?.trim() || undefined,
    FORGEJO_SRC_ORG: e.FORGEJO_SRC_ORG?.trim() || undefined,
  };
  const given = Object.entries(set).filter(([, v]) => v !== undefined);
  if (given.length === 0) return { ...PRODUCTION_FORGEJO_ORGS, error: null };

  const refuse = (error: string): ForgejoOrgs => ({ ...PRODUCTION_FORGEJO_ORGS, error });
  if (given.length !== 3) {
    const missing = Object.keys(set).filter((k) => set[k as keyof typeof set] === undefined);
    return refuse(
      `Forgejo org config refused: set all of FORGEJO_APPS_ORG, FORGEJO_REVIEW_ORG and FORGEJO_SRC_ORG or none (missing ${missing.join(
        ', '
      )})`
    );
  }
  for (const [key, value] of given) {
    if (!ORG_NAME.test(value!))
      return refuse(`Forgejo org config refused: ${key} is not a valid org name`);
    // Forgejo matches org names case-insensitively, so every comparison here does too.
    if (PRODUCTION_NAMES.includes(value!.toLowerCase())) {
      return refuse(`Forgejo org config refused: ${key} names the production org ${value}`);
    }
  }
  const orgs = {
    apps: set.FORGEJO_APPS_ORG!,
    review: set.FORGEJO_REVIEW_ORG!,
    source: set.FORGEJO_SRC_ORG!,
  };
  if (new Set(Object.values(orgs).map((o) => o.toLowerCase())).size !== 3) {
    return refuse(
      'Forgejo org config refused: FORGEJO_APPS_ORG, FORGEJO_REVIEW_ORG and FORGEJO_SRC_ORG must be distinct'
    );
  }
  return { ...orgs, error: null };
}

/** This process's orgs. Every reader imports these; nothing else names an org. */
export const FORGEJO_ORGS: ForgejoOrgs = resolveForgejoOrgs(env);
export const FORGEJO_ORG = FORGEJO_ORGS.apps;
export const FORGEJO_REVIEW_ORG = FORGEJO_ORGS.review;
export const FORGEJO_SOURCE_ORG = FORGEJO_ORGS.source;
