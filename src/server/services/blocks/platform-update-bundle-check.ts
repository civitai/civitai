/**
 * STAFF PLATFORM UPDATES: does the version being submitted carry them?
 *
 * Every path that files a publish request asks, for each of the app's updates that NO APPROVED
 * VERSION HAS SHIPPED yet (`listUnshippedPlatformUpdates`: not superseded, author staff now),
 * whether the version's files contain it (`updatePathGaps` in `platform-update-containment.ts`,
 * the shared predicate; a `package.json` or `pnpm-lock.yaml` is compared by the dependency changes
 * the update makes, and a refusal names each one missing). A
 * client's `merged` report is not read: only the files are.
 *
 *   - Bundle upload (`submitVersion`: the CLI's token route, the signed-in session route that App
 *     Assistant's Submit uses, and a moderator queueing a version of another account's app): a
 *     bundle missing an update is REFUSED with {@link PlatformUpdateMissingRefusal}, unless the
 *     client sent `allowUnmergedPlatformUpdate: true`. Then it is queued, and what it left out is
 *     recorded for the moderator (`fileSummary.platformUpdatesMissing`, via `override`) and
 *     returned as an advisory.
 *   - Git push to the build repo, and the web manifest editor's commit (`recordPendingFromPush`):
 *     NEVER refused. The commit is already in the repo and there is no client to send an
 *     override, so refusing would only drop the review request. What the commit left out is
 *     recorded the same way (via `push`) and returned as an advisory, which the webhook also puts
 *     on the commit as a `warning` status.
 *   - A STAFF SUBMIT ON THE OWNER'S BEHALF (`submitVersion` with `submittedOnBehalf`, a
 *     moderator only): never refused. Its bundle is the approved version plus the one update staff
 *     submits, so it lacks every other unshipped update by construction. What it left out is
 *     recorded the same way (via `on-behalf`).
 *   - Approve (`approveRequest`): once the version goes live (not when a late hold re-suspends
 *     it), the check runs again on the bytes being approved, and every update they contain is
 *     marked shipped by this request ({@link markShippedPlatformUpdates}). The submit-time answer
 *     is not reused. ONLY AN OWNER'S BUILD SHIPS an update: approving a staff on-behalf request,
 *     or a reset-to-pending copy of one ({@link shipsNoPlatformUpdates}), marks nothing, so the
 *     owner's own next submit is still checked for it. A shipped update is never checked again,
 *     so the owner's later edits to the same files are not refused forever.
 *
 * An update whose recorded commits cannot be read from the source repo is reported MISSING (with
 * `unreadable`), never thrown: the submit's override still applies, the moderator sees it, an
 * approve does not ship it, and the refusal says staff can withdraw it (`supersede`).
 *
 * At most {@link PLATFORM_UPDATE_CHECK_CAP} updates are checked, the OLDEST first; past that the
 * check is `truncated` (logged, and said in the refusal).
 *
 * Off: the `app-blocks-platform-updates` flag off, or the table or its `shipped` columns missing
 * (the manual migrations not applied; logged once per process). A first version (no app yet) has
 * no updates and is not queried.
 *
 * Cost per check: one query; for each update its two recorded source-repo trees (cached by commit,
 * so an update cut from another's commit costs one); and from the version being checked only the
 * paths some update touches.
 */
import { logToAxiom } from '~/server/logging/client';
import { APP_PLATFORM_UPDATE_SENDER } from '~/shared/constants/app-assistant.constants';
import { shipsNoPlatformUpdates } from '~/shared/utils/publish-request-on-behalf';
import type { Advisory } from './submit-advisories';
import { missingUpdateChanges } from './platform-update-containment';
// The cap is a constant of the shipped module (its query's LIMIT); that module imports nothing
// back from here.
import {
  PLATFORM_UPDATE_CHECK_CAP,
  type UnshippedPlatformUpdates,
} from './app-platform-update-shipped';
import type * as ForgejoService from './forgejo.service';

export const PLATFORM_UPDATE_MISSING_CODE = 'platform_update_missing';
export const PLATFORM_UPDATE_MISSING_ADVISORY = 'platform-update-missing';
export { PLATFORM_UPDATE_CHECK_CAP };

export type MissingPlatformUpdate = {
  id: string;
  reason: string;
  /**
   * The staff account's username; `null` when it no longer exists. For the moderator record only
   * ({@link platformUpdatesMissingRecord}): what the owner reads names
   * {@link APP_PLATFORM_UPDATE_SENDER} instead ({@link ownerFacingUpdate}).
   */
  by: string | null;
  /** The update's paths the version does not hold, in the record's order. */
  paths: string[];
  /**
   * The dependency changes those paths lack, named (e.g. `package.json: @civitai/sdk
   * (dependencies) must be 0.34.0, bundle has 0.33.0`), for a `package.json` or `pnpm-lock.yaml`
   * that parsed; absent when none could be named.
   */
  changes?: string[];
  /**
   * The update's recorded commits could not be read from the source repo, so it was not checked:
   * reported missing (every path), and staff can withdraw it.
   */
  unreadable?: true;
};

export type PlatformUpdateCheck = {
  /** The updates the version contains (ids, oldest first). */
  contained: string[];
  missing: MissingPlatformUpdate[];
  /** More unshipped updates than {@link PLATFORM_UPDATE_CHECK_CAP}: only the oldest were checked. */
  truncated?: true;
};

export type BundleCheckDeps = {
  flagOn: () => Promise<boolean>;
  /** Oldest first, at most the cap; `null` when the table or its columns are missing. */
  unshipped: (appBlockId: string) => Promise<UnshippedPlatformUpdates | null>;
  /** path → blob sha of the app's SOURCE repo at a commit. */
  sourceTree: (slug: string, commitSha: string) => Promise<Map<string, string>>;
  sourceBlob: (slug: string, blobSha: string) => Promise<Buffer>;
  /** Told once per process that the check is off for a missing table or column. */
  logUnavailable: () => void;
  /** Told when an update's recorded commits could not be read (it is reported missing). */
  logUnreadable: (args: { appBlockId: string; updateId: string; error: string }) => void;
  /** Told when the app has more unshipped updates than the cap (only the oldest are checked). */
  logTruncated: (args: { appBlockId: string; cap: number }) => void;
};

let loggedUnavailable = false;

const warn = (message: string, data: Record<string, unknown>) =>
  void Promise.resolve(
    logToAxiom({ name: 'app-platform-update', type: 'warning', message, ...data }, 'webhooks')
  ).catch(() => undefined);

// One import, shared: the tree and blob reads run concurrently, and each awaiting its own
// `import()` of the same module is needless (and under Vitest's module mocks, two concurrent
// dynamic imports of one mocked module were measured to resolve one to the real module).
let sourceRepo: Promise<{
  forgejo: typeof ForgejoService;
  org: string;
}> | null = null;
const sourceRepoModules = () =>
  (sourceRepo ??= Promise.all([import('./forgejo.service'), import('./forgejo-orgs')]).then(
    ([forgejo, orgs]) => ({ forgejo, org: orgs.FORGEJO_SOURCE_ORG })
  ));

/** The production dependencies (exported so a test can replace only the git-host reads). */
export const liveBundleCheckDeps: BundleCheckDeps = {
  // The flag's own module: with the flag off, the record service is never loaded.
  flagOn: async () => (await import('./app-platform-update-flag')).isPlatformUpdatesEnabled(),
  unshipped: async (appBlockId) =>
    (await import('./app-platform-update-shipped')).listUnshippedPlatformUpdates(appBlockId),
  sourceTree: async (slug, commitSha) => {
    const { forgejo, org } = await sourceRepoModules();
    return forgejo.listRepoTreeAtRef(slug, commitSha, org);
  },
  sourceBlob: async (slug, blobSha) => {
    const { forgejo, org } = await sourceRepoModules();
    return forgejo.getBlobContent(slug, blobSha, org);
  },
  logUnavailable: () => {
    if (loggedUnavailable) return;
    loggedUnavailable = true;
    warn('bundle check off: the platform-update table or its shipped columns are missing', {});
  },
  logUnreadable: (data) =>
    warn('bundle check: an update could not be read; reported missing', data),
  logTruncated: (data) => warn('bundle check: more unshipped updates than the cap', data),
};

/**
 * Which of the app's unshipped updates the version contains, and which it does not. `null` when the
 * check is off (flag, a first version, or the table or columns missing). `readFiles` reads the
 * version's files at the given paths (a path it lacks is absent from the map); it is called at most
 * once, with only the paths the updates touch.
 *
 * An update whose recorded commits cannot be read is reported missing (`unreadable`), never
 * thrown. Throws only when the record query or `readFiles` (the version's own files) fails: the
 * caller decides (a submit fails, the push and approve paths log and go on).
 */
export async function checkPlatformUpdates(
  args: {
    appBlockId: string | null;
    readFiles: (paths: string[]) => Promise<Map<string, Buffer>>;
  },
  deps: BundleCheckDeps = liveBundleCheckDeps
): Promise<PlatformUpdateCheck | null> {
  if (!(await deps.flagOn())) return null;
  if (!args.appBlockId) return null;
  const listed = await deps.unshipped(args.appBlockId);
  if (listed === null) {
    deps.logUnavailable();
    return null;
  }
  const { updates, truncated } = listed;
  if (truncated) deps.logTruncated({ appBlockId: args.appBlockId, cap: PLATFORM_UPDATE_CHECK_CAP });
  const more = truncated ? ({ truncated: true } as const) : {};
  if (!updates.length) return { contained: [], missing: [], ...more };

  const touched = [...new Set(updates.flatMap((u) => u.paths.map((p) => p.path)))];
  const have = await args.readFiles(touched);

  const trees = new Map<string, Promise<Map<string, string>>>();
  const treeAt = (slug: string, sha: string) => {
    const key = `${slug}@${sha}`;
    if (!trees.has(key)) trees.set(key, deps.sourceTree(slug, sha));
    return trees.get(key)!;
  };
  const blobs = new Map<string, Promise<Buffer>>();
  const blob = (slug: string, sha: string | undefined): Promise<Buffer | null> => {
    if (!sha) return Promise.resolve(null);
    const key = `${slug}@${sha}`;
    if (!blobs.has(key)) blobs.set(key, deps.sourceBlob(slug, sha));
    return blobs.get(key)!;
  };

  const contained: string[] = [];
  const missing: MissingPlatformUpdate[] = [];
  for (const update of updates) {
    const entry = { id: update.id, reason: update.reason, by: update.by };
    let found: Awaited<ReturnType<typeof missingUpdateChanges>>;
    try {
      const [target, base] = await Promise.all([
        treeAt(update.slug, update.commitSha),
        treeAt(update.slug, update.baseCommitSha),
      ]);
      found = await missingUpdateChanges(update.paths, async (path) => {
        const [want, was] = await Promise.all([
          blob(update.slug, target.get(path)),
          blob(update.slug, base.get(path)),
        ]);
        return { want, base: was, have: have.get(path) ?? null };
      });
    } catch (err) {
      // Not checked, so not contained: reported missing, for the override and the moderator.
      deps.logUnreadable({
        appBlockId: args.appBlockId,
        updateId: update.id,
        error: err instanceof Error ? err.message : String(err),
      });
      missing.push({ ...entry, paths: update.paths.map((p) => p.path), unreadable: true });
      continue;
    }
    if (!found.length) {
      contained.push(update.id);
      continue;
    }
    const changes = found.flatMap((m) => m.changes);
    missing.push({
      ...entry,
      paths: found.map((m) => m.path),
      ...(changes.length ? { changes } : {}),
    });
  }
  return { contained, missing, ...more };
}

// ---------------------------------------------------------------------------
// What the submitter, the moderator and the approve see
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const UNREADABLE_NOTE =
  ' [its files could not be read from the source repo; Civitai staff can withdraw it]';

/**
 * The update as its app's owner reads it (the refusal, its `details`, the advisories): from
 * {@link APP_PLATFORM_UPDATE_SENDER}, never the staff member's username (operator decision). Every
 * update here has a verified-staff author: `listUnshippedPlatformUpdates` returns only those
 * (`isVerifiedStaff`), the rule `ownerView` names the official sender under, so an update whose
 * author is no longer staff is never checked and never named. The moderator record keeps `by`.
 */
export function ownerFacingUpdate(update: MissingPlatformUpdate): MissingPlatformUpdate {
  return { ...update, by: APP_PLATFORM_UPDATE_SENDER };
}

/** One owner-facing update: always read through {@link ownerFacingUpdate}. */
function describeUpdate(missing: MissingPlatformUpdate): string {
  const update = ownerFacingUpdate(missing);
  const changes = update.changes?.length ? ` [${update.changes.join('; ')}]` : '';
  return `${update.id} by ${update.by} ("${update.reason}"): ${update.paths.join(
    ', '
  )}${changes}${update.unreadable ? UNREADABLE_NOTE : ''}`;
}

const truncatedNote = (truncated: boolean | undefined) =>
  truncated
    ? ` (only the oldest ${PLATFORM_UPDATE_CHECK_CAP} unshipped platform updates were checked; more may be missing)`
    : '';

export function platformUpdateMissingMessage(
  missing: MissingPlatformUpdate[],
  opts: { truncated?: boolean } = {}
): string {
  const n = missing.length;
  const them = plural(n, 'it', 'them');
  return (
    `this bundle does not contain ${plural(n, 'a platform update', `${n} platform updates`)} ` +
    `from Civitai staff that ${plural(n, 'has', 'have')} not shipped yet: ` +
    `${missing.map(describeUpdate).join('; ')}${truncatedNote(opts.truncated)}. Merge ${them} ` +
    `into the app and submit again, or submit ` +
    `with --allow-unmerged-platform-update (allowUnmergedPlatformUpdate: true) to send it for ` +
    `review without ${them}; the moderator is shown what was left out`
  );
}

/**
 * A submit refused for a bundle missing an unshipped platform update. Routes answer 409 with
 * `message`, `code` and `details`, all owner-facing: `details.updates` names the official sender.
 */
export class PlatformUpdateMissingRefusal extends Error {
  readonly code = PLATFORM_UPDATE_MISSING_CODE;
  readonly status = 409;
  readonly details: { updates: MissingPlatformUpdate[]; truncated?: true };
  constructor(missing: MissingPlatformUpdate[], opts: { truncated?: boolean } = {}) {
    super(platformUpdateMissingMessage(missing, opts));
    this.name = 'PlatformUpdateMissingRefusal';
    this.details = {
      updates: missing.map(ownerFacingUpdate),
      ...(opts.truncated ? { truncated: true as const } : {}),
    };
  }
}

export function isPlatformUpdateMissingRefusal(err: unknown): err is PlatformUpdateMissingRefusal {
  return err instanceof PlatformUpdateMissingRefusal;
}

/** Stored under `fileSummary.platformUpdatesMissing`, for the moderator (`reviewPlatformUpdates.ts`). */
export type PlatformUpdatesMissingRecord = {
  /**
   * `override`: the client sent `allowUnmergedPlatformUpdate`. `push`: a git push, never refused.
   * `on-behalf`: a staff submit on the owner's behalf, never refused.
   */
  via: 'override' | 'push' | 'on-behalf';
  updates: Array<{ id: string; by: string | null; paths: string[]; unreadable?: true }>;
  /** Only the oldest {@link PLATFORM_UPDATE_CHECK_CAP} unshipped updates were checked. */
  truncated?: true;
};

export function platformUpdatesMissingRecord(
  missing: MissingPlatformUpdate[],
  via: PlatformUpdatesMissingRecord['via'],
  opts: { truncated?: boolean } = {}
): PlatformUpdatesMissingRecord | null {
  if (!missing.length) return null;
  return {
    via,
    updates: missing.map(({ id, by, paths, unreadable }) => ({
      id,
      by,
      paths,
      ...(unreadable ? { unreadable } : {}),
    })),
    ...(opts.truncated ? { truncated: true as const } : {}),
  };
}

export function platformUpdateMissingAdvisories(
  missing: MissingPlatformUpdate[],
  via: PlatformUpdatesMissingRecord['via'],
  opts: { truncated?: boolean } = {}
): Advisory[] {
  if (!missing.length) return [];
  const n = missing.length;
  const what = `${plural(n, 'a platform update', `${n} platform updates`)} from Civitai staff`;
  const list = `${missing.map(describeUpdate).join('; ')}${truncatedNote(opts.truncated)}`;
  return [
    {
      code: PLATFORM_UPDATE_MISSING_ADVISORY,
      message:
        via === 'push'
          ? `This commit does not contain ${what}: ${list}. It was recorded for review anyway, and the moderator is shown what it left out. Merge ${plural(
              n,
              'it',
              'them'
            )} and push again.`
          : `Submitted without ${what}: ${list}. The moderator reviewing this version is shown what it left out.`,
    },
  ];
}

/** What the submit check found: the updates the bundle left out, and whether the check was capped. */
export type BundlePlatformUpdates = { missing: MissingPlatformUpdate[]; truncated: boolean };

/**
 * The submit check (`submitVersion`): refuses a bundle missing an update unless `allow`; with
 * `allow`, returns what it left out. `missing: []` when the check is off or nothing is missing.
 */
export async function assertBundleHasPlatformUpdates(
  args: {
    appBlockId: string | null;
    readFiles: (paths: string[]) => Promise<Map<string, Buffer>>;
    allow: boolean;
  },
  deps?: BundleCheckDeps
): Promise<BundlePlatformUpdates> {
  const check = await checkPlatformUpdates(args, deps);
  if (!check?.missing.length) return { missing: [], truncated: false };
  const truncated = check.truncated === true;
  if (!args.allow) throw new PlatformUpdateMissingRefusal(check.missing, { truncated });
  return { missing: check.missing, truncated };
}

/**
 * The approve step, once the version is live: re-checks the approved bytes and marks every update
 * they contain shipped by `publishRequestId`. A staff build ({@link shipsNoPlatformUpdates}: a
 * staff on-behalf request or a reset-to-pending copy of one) marks nothing and runs no check. An
 * update whose commits cannot be read is not contained, so it stays unshipped. Never throws (an
 * approve never fails over it): a failure is logged and leaves the updates unshipped, so the next
 * submit still checks them. Returns the ids marked.
 */
export async function markShippedPlatformUpdates(
  args: {
    appBlockId: string;
    publishRequestId: string;
    /** The approved request's `fileSummary`. */
    fileSummary: unknown;
    readFiles: (paths: string[]) => Promise<Map<string, Buffer>>;
  },
  deps?: BundleCheckDeps & {
    markShipped?: (ids: string[], publishRequestId: string) => Promise<number>;
  }
): Promise<string[]> {
  if (shipsNoPlatformUpdates(args.fileSummary)) return [];
  try {
    const check = await checkPlatformUpdates(args, deps);
    if (!check?.contained.length) return [];
    const mark =
      deps?.markShipped ??
      (async (ids: string[], id: string) =>
        (await import('./app-platform-update-shipped')).markPlatformUpdatesShipped(ids, id));
    await mark(check.contained, args.publishRequestId);
    return check.contained;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[platform-updates] could not mark the updates shipped by ${
        args.publishRequestId
      }; they stay unshipped: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}
