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

/** Where a version came from: the root lockfile the bundle carries. */
export type LockfileKind = 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock';

/** Checked in this order; the first one present in the bundle's root is the one read. */
const LOCKFILES: readonly LockfileKind[] = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

/** One package below its minimum. */
export interface SdkFloorFinding {
  package: string;
  installed: string;
  minimum: string;
}

/**
 * What a publish request records (under `fileSummary.sdkFloor`, so no column is added): the
 * server's reading of the bundle's lockfile and, separately, what the client said it overrode.
 * The two are never merged: `override` is the client's claim, `below` is the server's reading.
 */
export interface SdkFloorRecord {
  /** The lockfile read, or `null` when the bundle carries none the server reads. */
  lockfile: LockfileKind | null;
  /** Packages the lockfile resolves below their minimum. */
  below: SdkFloorFinding[];
  /** What the client reported overriding with `--allow-outdated-sdk`; `null` when none was sent. */
  override: SdkFloorFinding[] | null;
}

/** The submit waits at most this long for the lockfile read; past it there is no finding. */
export const SDK_FLOOR_TIMEOUT_MS = 2_000;

/** The bundle's lockfile and the version it resolves each floored package to. */
export async function lockedSdkVersions(
  bundleBuffer: Buffer,
  floors: readonly PlatformSdkFloor[] = PLATFORM_SDK_FLOORS
): Promise<{ lockfile: LockfileKind; versions: Map<string, string> } | null> {
  const zip = await JSZip.loadAsync(bundleBuffer);
  for (const lockfile of LOCKFILES) {
    const entry = zip.file(lockfile);
    if (!entry || entry.dir) continue;
    // `submitVersion` already ran `extractBundleMetadata` over this bundle, which refuses any
    // entry over the per-file cap, so this read is bounded by it.
    const body = (await entry.async('string')).replace(/^﻿/, '');
    const versions = new Map<string, string>();
    for (const { name } of floors) {
      const v = lockedVersion(lockfile, body, name);
      if (v) versions.set(name, v);
    }
    return { lockfile, versions };
  }
  return null;
}

function lockedVersion(kind: LockfileKind, body: string, name: string): string | null {
  try {
    if (kind === 'package-lock.json') return npmLockedVersion(body, name);
    if (kind === 'pnpm-lock.yaml') return pnpmLockedVersion(body, name);
    return yarnLockedVersion(body, name);
  } catch {
    return null;
  }
}

/** `packages["node_modules/<name>"]` (lockfile v2/v3), else v1's `dependencies[<name>]`. */
function npmLockedVersion(body: string, name: string): string | null {
  const lock = JSON.parse(body) as {
    packages?: Record<string, { version?: unknown }>;
    dependencies?: Record<string, { version?: unknown }>;
  };
  const v = lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version;
  return typeof v === 'string' && v ? v : null;
}

/**
 * The root importer's (`importers["."]`, v6+/v9) or top-level (v5/v6) direct dependency, either a
 * bare string (v5) or `{ specifier, version }` (v6+), with a peer suffix — `0.31.0(react@19.0.0)`
 * or `0.31.0_react@19.0.0` — stripped.
 */
function pnpmLockedVersion(body: string, name: string): string | null {
  type DepSets = {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  const lock = (yaml.load(body) ?? {}) as DepSets & { importers?: Record<string, DepSets> };
  const sets: DepSets[] = [];
  if (lock.importers?.['.']) sets.push(lock.importers['.']);
  sets.push(lock);
  for (const set of sets) {
    for (const deps of [set.dependencies, set.devDependencies]) {
      if (!deps || !(name in deps)) continue;
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
}

/**
 * yarn v1 (`"name@^1":` then `version "1.0.0"`) and berry (`"name@npm:^1":` then
 * `version: 1.0.0`). More than one distinct version cannot say which the app imports: none.
 */
function yarnLockedVersion(body: string, name: string): string | null {
  const found = new Set<string>();
  let inEntry = false;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    if (line[0] !== ' ' && line[0] !== '\t') {
      inEntry = line
        .replace(/:$/, '')
        .split(',')
        .some((spec) => spec.trim().replace(/^"|"$/g, '').startsWith(`${name}@`));
      continue;
    }
    if (!inEntry) continue;
    const t = line.trim();
    if (!t.startsWith('version')) continue;
    const v = t.slice('version'.length).trim().replace(/^:/, '').trim().replace(/^"|"$/g, '');
    if (v) found.add(v);
  }
  return found.size === 1 ? [...found][0]! : null;
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
 * The server's reading of the bundle: never throws, and answers "no lockfile, nothing below" past
 * `timeoutMs` or on any failure, so it can neither fail nor hold up a submit.
 */
export async function judgeBundleSdkFloor(
  bundleBuffer: Buffer,
  {
    read = lockedSdkVersions,
    timeoutMs = SDK_FLOOR_TIMEOUT_MS,
  }: { read?: typeof lockedSdkVersions; timeoutMs?: number } = {}
): Promise<{ lockfile: LockfileKind | null; below: SdkFloorFinding[] }> {
  const none = { lockfile: null, below: [] as SdkFloorFinding[] };
  const judged = (async () => {
    const locked = await read(bundleBuffer);
    if (!locked) return none;
    return { lockfile: locked.lockfile, below: belowSdkFloor(locked.versions) };
  })();
  try {
    return await withTimeoutFallback(judged, timeoutMs, none);
  } catch {
    return none;
  }
}

/** What to store, or `null` when there is nothing worth a moderator's attention. */
export function sdkFloorRecord(
  judged: { lockfile: LockfileKind | null; below: SdkFloorFinding[] },
  override: SdkFloorFinding[] | undefined
): SdkFloorRecord | null {
  if (judged.below.length === 0 && !override?.length) return null;
  return {
    lockfile: judged.lockfile,
    below: judged.below,
    override: override?.length ? override : null,
  };
}
