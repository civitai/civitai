/**
 * STAFF PLATFORM UPDATES: does the version being submitted carry them?
 *
 * Every path that files a publish request asks, for each of the app's updates that NO APPROVED
 * VERSION HAS SHIPPED yet (`listUnshippedPlatformUpdates`: not superseded, author staff now),
 * whether the version's files contain it ({@link pathHoldsUpdate}, the shared predicate). A
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
 *   - Approve (`approveRequest`): the check runs again on the bytes being approved, and every
 *     update they contain is marked shipped by this request ({@link markShippedPlatformUpdates}).
 *     The submit-time answer is not reused. A shipped update is never checked again, so the
 *     owner's later edits to the same files are not refused forever.
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
import type { Advisory } from './submit-advisories';
import { pathHoldsUpdate } from './platform-update-containment';
import type { UnshippedPlatformUpdate } from './app-platform-update-shipped';
import type * as ForgejoService from './forgejo.service';

export const PLATFORM_UPDATE_MISSING_CODE = 'platform_update_missing';
export const PLATFORM_UPDATE_MISSING_ADVISORY = 'platform-update-missing';

export type MissingPlatformUpdate = {
  id: string;
  reason: string;
  /** The staff account's username; `null` when it no longer exists. */
  by: string | null;
  /** The update's paths the version does not hold, in the record's order. */
  paths: string[];
};

export type PlatformUpdateCheck = {
  /** The updates the version contains (ids, oldest first). */
  contained: string[];
  missing: MissingPlatformUpdate[];
};

export type BundleCheckDeps = {
  flagOn: () => Promise<boolean>;
  /** `null` when the table or its columns are missing. */
  unshipped: (appBlockId: string) => Promise<UnshippedPlatformUpdate[] | null>;
  /** path → blob sha of the app's SOURCE repo at a commit. */
  sourceTree: (slug: string, commitSha: string) => Promise<Map<string, string>>;
  sourceBlob: (slug: string, blobSha: string) => Promise<Buffer>;
  /** Told once per process that the check is off for a missing table or column. */
  logUnavailable: () => void;
};

let loggedUnavailable = false;

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
    void Promise.resolve(
      logToAxiom(
        {
          name: 'app-platform-update',
          type: 'warning',
          message: 'bundle check off: the platform-update table or its shipped columns are missing',
        },
        'webhooks'
      )
    ).catch(() => undefined);
  },
};

/**
 * Which of the app's unshipped updates the version contains, and which it does not. `null` when the
 * check is off (flag, a first version, or the table or columns missing). `readFiles` reads the
 * version's files at the given paths (a path it lacks is absent from the map); it is called at most
 * once, with only the paths the updates touch.
 *
 * Throws when the source repo cannot be read: the caller decides (a submit fails, the push and
 * approve paths log and go on).
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
  const updates = await deps.unshipped(args.appBlockId);
  if (updates === null) {
    deps.logUnavailable();
    return null;
  }
  if (!updates.length) return { contained: [], missing: [] };

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
    const [target, base] = await Promise.all([
      treeAt(update.slug, update.commitSha),
      treeAt(update.slug, update.baseCommitSha),
    ]);
    const paths: string[] = [];
    for (const { path } of update.paths) {
      const [want, was] = await Promise.all([
        blob(update.slug, target.get(path)),
        blob(update.slug, base.get(path)),
      ]);
      if (!pathHoldsUpdate({ want, base: was, have: have.get(path) ?? null })) paths.push(path);
    }
    if (paths.length) missing.push({ id: update.id, reason: update.reason, by: update.by, paths });
    else contained.push(update.id);
  }
  return { contained, missing };
}

// ---------------------------------------------------------------------------
// What the submitter, the moderator and the approve see
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function describeUpdate(update: MissingPlatformUpdate): string {
  return `${update.id} by ${update.by ?? 'Civitai staff'} ("${update.reason}"): ${update.paths.join(
    ', '
  )}`;
}

export function platformUpdateMissingMessage(missing: MissingPlatformUpdate[]): string {
  const n = missing.length;
  const them = plural(n, 'it', 'them');
  return (
    `this bundle does not contain ${plural(n, 'a platform update', `${n} platform updates`)} ` +
    `from Civitai staff that ${plural(n, 'has', 'have')} not shipped yet: ` +
    `${missing
      .map(describeUpdate)
      .join('; ')}. Merge ${them} into the app and submit again, or submit ` +
    `with --allow-unmerged-platform-update (allowUnmergedPlatformUpdate: true) to send it for ` +
    `review without ${them}; the moderator is shown what was left out`
  );
}

/** A submit refused for a bundle missing an unshipped platform update. Routes answer 409. */
export class PlatformUpdateMissingRefusal extends Error {
  readonly code = PLATFORM_UPDATE_MISSING_CODE;
  readonly status = 409;
  readonly details: { updates: MissingPlatformUpdate[] };
  constructor(missing: MissingPlatformUpdate[]) {
    super(platformUpdateMissingMessage(missing));
    this.name = 'PlatformUpdateMissingRefusal';
    this.details = { updates: missing };
  }
}

export function isPlatformUpdateMissingRefusal(err: unknown): err is PlatformUpdateMissingRefusal {
  return err instanceof PlatformUpdateMissingRefusal;
}

/** Stored under `fileSummary.platformUpdatesMissing`, for the moderator (`reviewPlatformUpdates.ts`). */
export type PlatformUpdatesMissingRecord = {
  /** `override`: the client sent `allowUnmergedPlatformUpdate`. `push`: a git push, never refused. */
  via: 'override' | 'push';
  updates: Array<{ id: string; by: string | null; paths: string[] }>;
};

export function platformUpdatesMissingRecord(
  missing: MissingPlatformUpdate[],
  via: PlatformUpdatesMissingRecord['via']
): PlatformUpdatesMissingRecord | null {
  if (!missing.length) return null;
  return { via, updates: missing.map(({ id, by, paths }) => ({ id, by, paths })) };
}

export function platformUpdateMissingAdvisories(
  missing: MissingPlatformUpdate[],
  via: PlatformUpdatesMissingRecord['via']
): Advisory[] {
  if (!missing.length) return [];
  const n = missing.length;
  const what = `${plural(n, 'a platform update', `${n} platform updates`)} from Civitai staff`;
  const list = missing.map(describeUpdate).join('; ');
  return [
    {
      code: PLATFORM_UPDATE_MISSING_ADVISORY,
      message:
        via === 'override'
          ? `Submitted without ${what}: ${list}. The moderator reviewing this version is shown what it left out.`
          : `This commit does not contain ${what}: ${list}. It was recorded for review anyway, and the moderator is shown what it left out. Merge ${plural(
              n,
              'it',
              'them'
            )} and push again.`,
    },
  ];
}

/**
 * The submit check (`submitVersion`): refuses a bundle missing an update unless `allow`; with
 * `allow`, returns what it left out. `[]` when the check is off or nothing is missing.
 */
export async function assertBundleHasPlatformUpdates(
  args: {
    appBlockId: string | null;
    readFiles: (paths: string[]) => Promise<Map<string, Buffer>>;
    allow: boolean;
  },
  deps?: BundleCheckDeps
): Promise<MissingPlatformUpdate[]> {
  const check = await checkPlatformUpdates(args, deps);
  if (!check?.missing.length) return [];
  if (!args.allow) throw new PlatformUpdateMissingRefusal(check.missing);
  return check.missing;
}

/**
 * The approve step: re-checks the approved bytes and marks every update they contain shipped by
 * `publishRequestId`. Never throws (an approve never fails over it): a failure is logged and
 * leaves the updates unshipped, so the next submit still checks them. Returns the ids marked.
 */
export async function markShippedPlatformUpdates(
  args: {
    appBlockId: string;
    publishRequestId: string;
    readFiles: (paths: string[]) => Promise<Map<string, Buffer>>;
  },
  deps?: BundleCheckDeps & {
    markShipped?: (ids: string[], publishRequestId: string) => Promise<number>;
  }
): Promise<string[]> {
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
