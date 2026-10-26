/** The SDK package an App Block talks to its host through. */
export const CIVITAI_SDK = '@civitai/sdk';

/**
 * The lowest `@civitai/sdk` an app should declare: the minor the host (this repo's own root
 * `package.json`) speaks. An app pinned below it is upgraded to it by the runner (`checkSdkPin`, the runner's `SdkUpgrades`). A `^0.x` range
 * never moves to a newer minor, so an app scaffolded on an older SDK never gets the host's newer
 * bridge messages on its own (0.21.0 added `VIEWER_ACTIVITY`, which keeps the preview awake).
 *
 * Bump it together with the root `package.json`'s `@civitai/sdk` on each SDK minor release: the
 * runner's `sdk-floor.test.ts` fails while the two disagree. It only reaches the runner with a runner
 * release.
 */
export const CIVITAI_SDK_FLOOR = '0.21.0';

/** What an app's `package.json` declares for `@civitai/sdk`, as `checkSdkPin` judges it. */
export type SdkPinCheck =
  /** It does not depend on `@civitai/sdk`. */
  | { kind: 'absent' }
  /** At or above the floor's minor. */
  | { kind: 'current'; declared: string }
  /** Below the floor's minor: the app should upgrade. */
  | { kind: 'stale'; declared: string }
  /** A range this check does not read (`latest`, `>=…`, `workspace:*`, a URL): judged neither way. */
  | { kind: 'unparseable'; declared: unknown };

/** `MAJOR.MINOR[.PATCH][-pre]`, bare or after one `^`, `~`, `=` or `v`: its major and minor. */
const SIMPLE_RANGE = /^\s*[\^~=v]?\s*(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]*)?\s*$/;

function majorMinor(range: string): [number, number] | null {
  const match = SIMPLE_RANGE.exec(range);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * Whether an installed `@civitai/sdk` version (its own `package.json`'s `version`) is below
 * `floor`'s minor; `null` when it is not a version this reads.
 */
export function installedSdkBelowFloor(
  version: unknown,
  floor: string = CIVITAI_SDK_FLOOR
): boolean | null {
  const have = typeof version === 'string' ? majorMinor(version) : null;
  const want = majorMinor(floor);
  if (!have || !want) return null;
  return below(have, want);
}

function below(have: [number, number], want: [number, number]): boolean {
  return have[0] < want[0] || (have[0] === want[0] && have[1] < want[1]);
}

/**
 * Whether an app's parsed `package.json` declares an `@civitai/sdk` below `floor`'s minor, in
 * `dependencies` or `devDependencies`. A range's own base version is what it is judged by: `^0.19.1`
 * and `~0.19.1` (which cannot reach 0.20) are stale against 0.21.0; `^1.0.0` is current.
 */
export function checkSdkPin(pkg: unknown, floor: string = CIVITAI_SDK_FLOOR): SdkPinCheck {
  const sections = pkg && typeof pkg === 'object' ? (pkg as Record<string, unknown>) : {};
  let declared: unknown;
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = sections[field];
    if (deps && typeof deps === 'object' && CIVITAI_SDK in deps) {
      declared = (deps as Record<string, unknown>)[CIVITAI_SDK];
      break;
    }
  }
  if (declared === undefined) return { kind: 'absent' };
  const have = typeof declared === 'string' ? majorMinor(declared) : null;
  const want = majorMinor(floor);
  if (!have || !want) return { kind: 'unparseable', declared };
  return { kind: below(have, want) ? 'stale' : 'current', declared: declared as string };
}
