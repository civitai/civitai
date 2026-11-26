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

/** The lines to show, or `[]` when the request records nothing about its SDK versions. */
export function reviewSdkFloorLines(fileSummary: unknown): ReviewSdkFloorLine[] {
  if (!fileSummary || typeof fileSummary !== 'object') return [];
  const rec = (fileSummary as { sdkFloor?: unknown }).sdkFloor;
  if (!rec || typeof rec !== 'object') return [];
  const below = findings((rec as { below?: unknown }).below) ?? [];
  const override = findings((rec as { override?: unknown }).override);
  const lockfile = (rec as { lockfile?: unknown }).lockfile;
  if (below.length === 0 && !override?.length) return [];

  const bundleValue = below.length
    ? render(below)
    : typeof lockfile === 'string'
    ? `none below the minimum in ${lockfile}`
    : 'no lockfile the server reads';
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
