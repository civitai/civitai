/**
 * The moderator review's OUTDATED-SDK lines (pure, React-free), from the `fileSummary.sdkFloor`
 * a submit records (`src/server/services/blocks/sdk-floor.ts`).
 *
 * 🔴 TWO SOURCES, NEVER MERGED, like the source-provenance lines beside them. `below` is the
 * server's own reading of the bundle's lockfile; `override` is what the submitting client SAID it
 * overrode with `civitai app submit --allow-outdated-sdk`, unchecked. One line never fills in for
 * the other.
 */

export const SDK_FLOOR_BUNDLE_LABEL = 'Outdated SDK (read from the bundle lockfile)';
export const SDK_FLOOR_OVERRIDE_LABEL = 'Outdated-SDK override (sent by the client, not checked)';

export type ReviewSdkFloorLine = {
  key: 'bundle' | 'override';
  heading: string;
  value: string;
};

type Finding = { package: string; installed: string; minimum: string };

function findings(raw: unknown): Finding[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Finding[] = [];
  for (const f of raw) {
    if (
      f &&
      typeof f === 'object' &&
      typeof (f as Finding).package === 'string' &&
      typeof (f as Finding).installed === 'string' &&
      typeof (f as Finding).minimum === 'string'
    ) {
      out.push(f as Finding);
    }
  }
  return out;
}

const render = (list: Finding[]) =>
  list.map((f) => `${f.package} ${f.installed} (minimum ${f.minimum})`).join(', ');

const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

/**
 * The bundle line when the server found nothing below: WHY it found nothing, from the
 * `lockfileStatus` recorded with the reading. A lockfile that was read and is fine, one the bundle
 * does not carry, and one the server could not read are three different things to a moderator.
 */
function noFindingValue(rec: object): string {
  const lockfile = (rec as { lockfile?: unknown }).lockfile;
  const status = (rec as { lockfileStatus?: unknown }).lockfileStatus;
  if (typeof lockfile !== 'string' || !LOCKFILES.has(lockfile)) {
    return 'no lockfile reading recorded';
  }
  if (status === 'read') return `none below the minimum in ${lockfile}`;
  if (status === 'absent') {
    return `the bundle carries no ${lockfile} (the lockfile its build command installs from)`;
  }
  if (status === 'unreadable') {
    return `${lockfile} could not be read (unparseable, or the read timed out)`;
  }
  return 'no lockfile reading recorded';
}

/** The lines to show, or `[]` when the request records nothing about its SDK versions. */
export function reviewSdkFloorLines(fileSummary: unknown): ReviewSdkFloorLine[] {
  if (!fileSummary || typeof fileSummary !== 'object') return [];
  const rec = (fileSummary as { sdkFloor?: unknown }).sdkFloor;
  if (!rec || typeof rec !== 'object') return [];
  const below = findings((rec as { below?: unknown }).below) ?? [];
  const override = findings((rec as { override?: unknown }).override);
  if (below.length === 0 && !override?.length) return [];

  const bundleValue = below.length ? render(below) : noFindingValue(rec);
  return [
    { key: 'bundle', heading: SDK_FLOOR_BUNDLE_LABEL, value: bundleValue },
    {
      key: 'override',
      heading: SDK_FLOOR_OVERRIDE_LABEL,
      value: override?.length
        ? `submitted with --allow-outdated-sdk: ${render(override)}`
        : 'none sent (the submitting client did not run the outdated-SDK check)',
    },
  ];
}
