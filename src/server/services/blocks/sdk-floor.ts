import JSZip from 'jszip';
import semver from 'semver';
import yaml from 'js-yaml';
import { PLATFORM_SDK_FLOORS, type PlatformSdkFloor } from '@civitai/app-assistant/sdk-floor';
import type { Advisory } from '@civitai/app-assistant/theme-evidence';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';

/**
 * THE OUTDATED-SDK CHECK, server half. The platform publishes a minimum version for each package
 * in `PLATFORM_SDK_FLOORS` (`GET /api/v1/blocks/sdk-floor`). `civitai app submit` refuses below it
 * unless the author passes `--allow-outdated-sdk`, and then sends what it found as
 * `sdkFloorOverride`. The server never refuses: it reads the bundle's own lockfile, answers a
 * `sdk-below-floor` advisory per package below the minimum (so a CLI that predates the check is
 * still told), and records both its own reading and the client's override for the moderator.
 *
 * The INSTALLED version is read from the lockfile, never package.json's range: a `^0.31.0` range
 * says nothing about what the build installs, and on 0.x a caret never leaves its minor.
 */

/** Where a version came from: the root lockfile the bundle's build installs from. */
export type LockfileKind = 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock';

/**
 * What the server could make of that lockfile: `read` (parsed; a package it does not name simply
 * has no version), `absent` (the bundle's root carries no such file), or `unreadable` (present but
 * unparseable, or the read failed or ran past `SDK_FLOOR_TIMEOUT_MS`).
 */
export type LockfileStatus = 'read' | 'absent' | 'unreadable';

/**
 * The lockfile the platform build installs from, chosen from the manifest's `buildCommand` exactly
 * as the CLI chooses it (civitai/cli `internal/validate/lockfile.go`, `packageManagerFor`, which
 * mirrors the build recipe's `PM="${BUILD_CMD%% *}"`): the FIRST WORD of the trimmed command,
 * `pnpm` → pnpm-lock.yaml, `yarn` → yarn.lock, and EVERYTHING else — `npm`, `vite`, `npx`, an
 * omitted or non-string buildCommand (the recipe's legacy `npm run build` default) — →
 * package-lock.json. Only that one file is read, as the CLI's `lockedBlocksReactVersion`
 * (`internal/validate/blocksreactversion.go`) does: a stale lockfile of another package manager
 * committed beside it is not what the build installs, so it is never consulted.
 */
export function lockfileFor(buildCommand: unknown): LockfileKind {
  const cmd = typeof buildCommand === 'string' ? buildCommand.trim() : '';
  const space = cmd.indexOf(' ');
  const first = space >= 0 ? cmd.slice(0, space) : cmd;
  if (first === 'pnpm') return 'pnpm-lock.yaml';
  if (first === 'yarn') return 'yarn.lock';
  return 'package-lock.json';
}

/** One package below its minimum. */
export interface SdkFloorFinding {
  package: string;
  installed: string;
  minimum: string;
}

/** The server's reading of the bundle's lockfile. */
export interface SdkFloorJudgement {
  /** The lockfile the build installs from (read or not; see `lockfileStatus`). */
  lockfile: LockfileKind;
  lockfileStatus: LockfileStatus;
  /** Packages the lockfile resolves below their minimum (empty unless `lockfileStatus` is `read`). */
  below: SdkFloorFinding[];
}

/**
 * What a publish request records (under `fileSummary.sdkFloor`, so no column is added): the
 * server's reading of the bundle's lockfile and, separately, what the client said it overrode.
 * The two are never merged: `override` is the client's claim, `below` is the server's reading.
 */
export interface SdkFloorRecord extends SdkFloorJudgement {
  /** What the client reported overriding with `--allow-outdated-sdk`; `null` when none was sent. */
  override: SdkFloorFinding[] | null;
}

/**
 * The submit waits at most this long for the lockfile reading; past it the reading is
 * `unreadable`. 🔴 What this bounds is the WAIT on the asynchronous steps (opening the zip and
 * inflating the entry, which yield to the event loop). The parse itself — a synchronous
 * `JSON.parse` / `yaml.load` / line scan — cannot be interrupted: once it starts it runs to
 * completion, and the timer can only fire after it returns. The parse is bounded by the per-file
 * size cap `extractBundleMetadata` already enforced on this bundle, not by this timeout.
 */
export const SDK_FLOOR_TIMEOUT_MS = 2_000;

/** A parsed lockfile: the version it resolves `name` to, or `null` when it cannot say. */
type LockfileLookup = (name: string) => string | null;

/**
 * The bundle's lockfile (chosen by `buildCommand`, see `lockfileFor`) and the version it resolves
 * each floored package to. The lockfile is parsed ONCE, then looked up per package.
 */
export async function lockedSdkVersions(
  bundleBuffer: Buffer,
  buildCommand: unknown,
  floors: readonly PlatformSdkFloor[] = PLATFORM_SDK_FLOORS
): Promise<{
  lockfile: LockfileKind;
  lockfileStatus: LockfileStatus;
  versions: Map<string, string>;
}> {
  const lockfile = lockfileFor(buildCommand);
  const versions = new Map<string, string>();
  const zip = await JSZip.loadAsync(bundleBuffer);
  const entry = zip.file(lockfile);
  if (!entry || entry.dir) return { lockfile, lockfileStatus: 'absent', versions };
  // `submitVersion` already ran `extractBundleMetadata` over this bundle, which refuses any
  // entry over the per-file cap, so this read is bounded by it. Every leading BOM is dropped,
  // as the CLI does.
  const body = (await entry.async('string')).replace(/^(?:\uFEFF)+/, '');
  let lookup: LockfileLookup;
  try {
    lookup = parseLockfile(lockfile, body);
  } catch {
    return { lockfile, lockfileStatus: 'unreadable', versions };
  }
  for (const { name } of floors) {
    const v = lookup(name);
    if (v) versions.set(name, v);
  }
  return { lockfile, lockfileStatus: 'read', versions };
}

/** Parses `body` once; throws when it is not a lockfile of `kind` at all. */
function parseLockfile(kind: LockfileKind, body: string): LockfileLookup {
  if (kind === 'package-lock.json') return npmLockfile(body);
  if (kind === 'pnpm-lock.yaml') return pnpmLockfile(body);
  return yarnLockfile(body);
}

function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a lockfile object');
  return v as Record<string, unknown>;
}

/** `packages["node_modules/<name>"]` (lockfile v2/v3), else v1's `dependencies[<name>]`. */
function npmLockfile(body: string): LockfileLookup {
  const lock = asObject(JSON.parse(body)) as {
    packages?: Record<string, { version?: unknown } | undefined>;
    dependencies?: Record<string, { version?: unknown } | undefined>;
  };
  return (name) => {
    const v =
      lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version;
    return typeof v === 'string' && v ? v : null;
  };
}

/**
 * The root importer's (`importers["."]`, v6+/v9) or top-level (v5/v6) direct dependency, either a
 * bare string (v5) or `{ specifier, version }` (v6+), with a peer suffix — `0.31.0(react@19.0.0)`
 * or `0.31.0_react@19.0.0` — stripped.
 */
function pnpmLockfile(body: string): LockfileLookup {
  type DepSets = {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  const lock = asObject(yaml.load(body) ?? {}) as DepSets & {
    importers?: Record<string, DepSets>;
  };
  const sets: DepSets[] = [];
  if (lock.importers?.['.']) sets.push(lock.importers['.']);
  sets.push(lock);
  return (name) => {
    for (const set of sets) {
      for (const deps of [set.dependencies, set.devDependencies]) {
        if (!deps || typeof deps !== 'object' || !(name in deps)) continue;
        const node = deps[name];
        let v: unknown = node;
        if (node && typeof node === 'object') v = (node as { version?: unknown }).version;
        if (typeof v !== 'string') return null;
        const cut = v.search(/[(_]/);
        const clean = cut >= 0 ? v.slice(0, cut) : v;
        return clean || null;
      }
    }
    return null;
  };
}

/**
 * yarn v1 (`"name@^1":` then `version "1.0.0"`) and berry (`"name@npm:^1":` then
 * `version: 1.0.0`). Scanned once into entries (header specs + versions); a lookup reads every
 * entry whose header names the package. More than one distinct version cannot say which the app
 * imports: none.
 */
function yarnLockfile(body: string): LockfileLookup {
  const entries: { specs: string[]; versions: string[] }[] = [];
  let current: { specs: string[]; versions: string[] } | null = null;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    if (line[0] !== ' ' && line[0] !== '\t') {
      current = {
        specs: line
          .replace(/:$/, '')
          .split(',')
          .map((spec) => spec.trim().replace(/^"|"$/g, '')),
        versions: [],
      };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const t = line.trim();
    if (!t.startsWith('version')) continue;
    const v = t.slice('version'.length).trim().replace(/^:/, '').trim().replace(/^"|"$/g, '');
    if (v) current.versions.push(v);
  }
  return (name) => {
    const found = new Set<string>();
    for (const e of entries) {
      if (!e.specs.some((spec) => spec.startsWith(`${name}@`))) continue;
      for (const v of e.versions) found.add(v);
    }
    return found.size === 1 ? [...found][0]! : null;
  };
}

/**
 * The packages `versions` resolves below their minimum, in `floors` order. A version SemVer cannot
 * parse is judged neither way (no finding).
 */
export function belowSdkFloor(
  versions: ReadonlyMap<string, string>,
  floors: readonly PlatformSdkFloor[] = PLATFORM_SDK_FLOORS
): SdkFloorFinding[] {
  const out: SdkFloorFinding[] = [];
  for (const { name, minimum } of floors) {
    const installed = versions.get(name);
    if (!installed || !semver.valid(installed) || !semver.valid(minimum)) continue;
    if (semver.lt(installed, minimum)) out.push({ package: name, installed, minimum });
  }
  return out;
}

/** The upgrade command for `pkg` under the package manager that wrote `lockfile`. */
export function upgradeCommand(lockfile: LockfileKind | null, pkg: string): string {
  if (lockfile === 'pnpm-lock.yaml') return `pnpm add ${pkg}@latest`;
  if (lockfile === 'yarn.lock') return `yarn add ${pkg}@latest`;
  return `npm install ${pkg}@latest`;
}

/** One `sdk-below-floor` advisory per package below its minimum. Never refuses the submit. */
export function sdkFloorAdvisories(
  lockfile: LockfileKind | null,
  below: readonly SdkFloorFinding[]
): Advisory[] {
  return below.map((f) => ({
    code: 'sdk-below-floor',
    message:
      `This app's ${lockfile ?? 'lockfile'} installs ${f.package} ${f.installed}, below the ` +
      `platform minimum ${f.minimum}. Upgrade with \`${upgradeCommand(lockfile, f.package)}\` ` +
      'and resubmit. The submit was not refused; a moderator sees the version.',
  }));
}

/**
 * The server's reading of the bundle: never throws, and answers `unreadable` with nothing below
 * on any failure or once `timeoutMs` has passed (see `SDK_FLOOR_TIMEOUT_MS` for what that bound
 * does and does not cover), so it can neither fail a submit nor hold it up on a slow read.
 */
export async function judgeBundleSdkFloor(
  bundleBuffer: Buffer,
  buildCommand: unknown,
  {
    read = lockedSdkVersions,
    timeoutMs = SDK_FLOOR_TIMEOUT_MS,
  }: { read?: typeof lockedSdkVersions; timeoutMs?: number } = {}
): Promise<SdkFloorJudgement> {
  const unreadable: SdkFloorJudgement = {
    lockfile: lockfileFor(buildCommand),
    lockfileStatus: 'unreadable',
    below: [],
  };
  const judged = (async (): Promise<SdkFloorJudgement> => {
    const locked = await read(bundleBuffer, buildCommand);
    return {
      lockfile: locked.lockfile,
      lockfileStatus: locked.lockfileStatus,
      below: belowSdkFloor(locked.versions),
    };
  })();
  try {
    return await withTimeoutFallback(judged, timeoutMs, unreadable);
  } catch {
    return unreadable;
  }
}

/** What to store, or `null` when there is nothing worth a moderator's attention. */
export function sdkFloorRecord(
  judged: SdkFloorJudgement,
  override: SdkFloorFinding[] | undefined
): SdkFloorRecord | null {
  if (judged.below.length === 0 && !override?.length) return null;
  return {
    lockfile: judged.lockfile,
    lockfileStatus: judged.lockfileStatus,
    below: judged.below,
    override: override?.length ? override : null,
  };
}
