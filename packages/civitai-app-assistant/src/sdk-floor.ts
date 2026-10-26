import { DEV_SERVER_COMMAND } from './instructions';

/** The SDK package an App Block talks to its host through. */
export const CIVITAI_SDK = '@civitai/sdk';

/**
 * The lowest `@civitai/sdk` an app should declare: the minor the host (this repo's own root
 * `package.json`) speaks. An app pinned below it is told to upgrade (`checkSdkPin`). A `^0.x` range
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
  const stale = have[0] < want[0] || (have[0] === want[0] && have[1] < want[1]);
  return { kind: stale ? 'stale' : 'current', declared: declared as string };
}

/**
 * What a reply is told when its app's `package.json` (in project directory `dir`) declares a stale
 * `@civitai/sdk`: bump it to `^floor`, install, restart the dev server with the shared command, and
 * change nothing else for it.
 */
export function sdkUpgradeInstruction(
  dir: string,
  declared: string,
  floor: string = CIVITAI_SDK_FLOOR
): string {
  return [
    `SDK upgrade, before the rest of this reply: ${dir}/package.json declares "${CIVITAI_SDK}": ${JSON.stringify(
      declared
    )}, below the current ${CIVITAI_SDK} ${floor}, and that range never reaches it by itself. The live preview needs the newer SDK (on an older one it can go to sleep while the user works in the app).`,
    `1) In ${dir}/package.json set "${CIVITAI_SDK}": "^${floor}", in the same section it is in now.`,
    `2) Run cd ${dir} && npm install.`,
    `3) Restart the dev server with sandbox__dev_server_restart (sandbox__dev_server_start when it is not running) and exactly this command: cd ${dir} && ${DEV_SERVER_COMMAND}.`,
    'Change no other code for this upgrade. If the typecheck or tests then fail because of it, tell the user what broke instead of rewriting the app. Tell the user in one line that you upgraded the SDK, then go on with what they asked.',
  ].join('\n');
}
