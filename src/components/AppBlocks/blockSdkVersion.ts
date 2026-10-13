/**
 * What a block reports about its SDK on
 * `BLOCK_READY { sdkVersion?: string; sdkName?: string }`, reduced to two bounded prom
 * labels. Two published packages each own a transport that sends BLOCK_READY, on
 * independent version lines, so a version is only meaningful beside its `sdkName`.
 *
 * INFORMATIONAL ONLY. It is not a protocol version and nothing is negotiated on it: it
 * feeds `civitai_app_block_sdk_ready_total` so the SDK versions still in use can be read
 * before an old bridge op is retired, and it never decides whether a block becomes ready.
 * Both fields are optional and independent.
 *
 * Nothing in this file may import anything — it is loaded by both browser hosts and by
 * the `/api/track/block-render` route.
 */

/** Highest `major` and `minor` that get their own label. Raising either grows the label set. */
export const SDK_VERSION_MAX_MAJOR = 0;
export const SDK_VERSION_MAX_MINOR = 149;

/** The block sent no `sdkVersion` — every SDK that predates the field. */
export const SDK_VERSION_UNKNOWN = 'unknown';
/** The block sent something that is not a plain in-range `major.minor.patch`. */
export const SDK_VERSION_INVALID = 'invalid';

/**
 * How many distinct values `sdkVersionLabel` can return:
 * (0 + 1) majors x (149 + 1) minors + `unknown` + `invalid` = 152.
 */
export const SDK_VERSION_LABEL_COUNT =
  (SDK_VERSION_MAX_MAJOR + 1) * (SDK_VERSION_MAX_MINOR + 1) + 2;

// Longest string the pattern below can match: 3 + 1 + 3 + 1 + 6.
const SDK_VERSION_MAX_LENGTH = 14;

// Plain `major.minor.patch`: no `v` prefix, no prerelease or build suffix, no leading
// zeros, no surrounding whitespace.
const PLAIN_SEMVER = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,5})$/;

/**
 * Reduce a reported SDK version to its label: `"<major>.<minor>"`, `unknown` when the
 * value is absent (`undefined`), `invalid` for everything else.
 *
 * 🔴 THIS IS THE CARDINALITY BOUND for the `sdk_version` label, and the bound is the two
 * integer ranges, not the pattern. The value comes from an untrusted iframe and then
 * from a public beacon body, so a version label is only ever BUILT from two integers
 * that passed a range check — the input string is never returned. The result is one of
 * exactly `SDK_VERSION_LABEL_COUNT` (152) values whatever is passed in.
 *
 * A version above either ceiling — any 1.x today — reads `invalid` until the ceiling is
 * raised. Both packages that report are on 0.x.
 */
export function sdkVersionLabel(value: unknown): string {
  if (value === undefined) return SDK_VERSION_UNKNOWN;
  if (typeof value !== 'string' || value.length > SDK_VERSION_MAX_LENGTH)
    return SDK_VERSION_INVALID;
  const match = PLAIN_SEMVER.exec(value);
  if (!match) return SDK_VERSION_INVALID;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > SDK_VERSION_MAX_MAJOR || minor > SDK_VERSION_MAX_MINOR) return SDK_VERSION_INVALID;
  return `${major}.${minor}`;
}

/** The packages that send BLOCK_READY, as they name themselves in `sdkName`. */
export const SDK_NAMES = ['blocks-react', 'sdk'] as const;
export type SdkName = (typeof SDK_NAMES)[number];
/** `sdkName` was absent, or was anything other than one of `SDK_NAMES`. */
export const SDK_NAME_UNKNOWN = 'unknown';

/**
 * Reduce a reported SDK name to the `sdk` label: the name when it is exactly one of
 * `SDK_NAMES`, otherwise `unknown` — 3 values whatever is passed in. Compared by
 * identity against the code-owned list, so the input string is never returned.
 */
export function sdkNameLabel(value: unknown): SdkName | typeof SDK_NAME_UNKNOWN {
  for (const name of SDK_NAMES) if (value === name) return name;
  return SDK_NAME_UNKNOWN;
}

/** The SDK fields a host forwards on the render beacon. A field the block did not report is absent. */
export type BlockReadySdk = { sdkVersion?: string; sdkName?: SdkName };

/**
 * What a host puts on the render beacon for a `BLOCK_READY` payload.
 *
 * `sdkVersion` is omitted when the payload carries none, is the reported string when
 * `sdkVersionLabel` accepts it, and is otherwise the `invalid` sentinel. `sdkName` is
 * present only when it is one of `SDK_NAMES`. So an over-long or non-string value never
 * reaches the request body, and the server re-derives both labels from what it
 * receives. Never throws.
 */
export function readBlockReadySdk(payload: unknown): BlockReadySdk {
  try {
    const out: BlockReadySdk = {};
    if (!payload || typeof payload !== 'object') return out;
    const { sdkVersion, sdkName } = payload as { sdkVersion?: unknown; sdkName?: unknown };
    if (sdkVersion !== undefined)
      out.sdkVersion =
        sdkVersionLabel(sdkVersion) === SDK_VERSION_INVALID
          ? SDK_VERSION_INVALID
          : (sdkVersion as string);
    const name = sdkNameLabel(sdkName);
    if (name !== SDK_NAME_UNKNOWN) out.sdkName = name;
    return out;
  } catch {
    // A payload that throws on read reports nothing.
    return {};
  }
}

/** Did the block report anything? An ack that reports nothing must not erase one that did. */
export function hasBlockReadySdk(sdk: BlockReadySdk): boolean {
  return sdk.sdkVersion !== undefined || sdk.sdkName !== undefined;
}
