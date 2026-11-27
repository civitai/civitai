/**
 * The moderator review's MISSING PLATFORM UPDATES line (pure, React-free), from the
 * `fileSummary.platformUpdatesMissing` a submit or push records
 * (`src/server/services/blocks/platform-update-bundle-check.ts`): the staff platform updates, not
 * yet shipped by any approved version, that this version's files do not contain. The server read
 * the files; this is not a client claim. `via` says why it was queued anyway.
 */

export const PLATFORM_UPDATES_OVERRIDE_LABEL =
  'Missing platform updates (submitted with --allow-unmerged-platform-update)';
export const PLATFORM_UPDATES_PUSH_LABEL =
  'Missing platform updates (git push, recorded without them)';
export const PLATFORM_UPDATES_ON_BEHALF_LABEL =
  "Missing platform updates (Civitai staff submission on the owner's behalf)";

export type ReviewPlatformUpdatesLine = {
  key: 'platform-updates';
  heading: string;
  value: string;
};

type Entry = { id: string; by: string | null; paths: string[]; unreadable: boolean };

function entries(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return [];
  const out: Entry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const { id, by, paths, unreadable } = e as {
      id?: unknown;
      by?: unknown;
      paths?: unknown;
      unreadable?: unknown;
    };
    if (typeof id !== 'string' || !Array.isArray(paths)) continue;
    out.push({
      id,
      by: typeof by === 'string' ? by : null,
      paths: paths.filter((p): p is string => typeof p === 'string'),
      unreadable: unreadable === true,
    });
  }
  return out;
}

/** The line to show, or `[]` when the request records no missing update. */
export function reviewPlatformUpdatesLines(fileSummary: unknown): ReviewPlatformUpdatesLine[] {
  if (!fileSummary || typeof fileSummary !== 'object') return [];
  const rec = (fileSummary as { platformUpdatesMissing?: unknown }).platformUpdatesMissing;
  if (!rec || typeof rec !== 'object') return [];
  const list = entries((rec as { updates?: unknown }).updates);
  if (!list.length) return [];
  const { via, truncated } = rec as { via?: unknown; truncated?: unknown };
  const heading =
    via === 'push'
      ? PLATFORM_UPDATES_PUSH_LABEL
      : via === 'on-behalf'
      ? PLATFORM_UPDATES_ON_BEHALF_LABEL
      : PLATFORM_UPDATES_OVERRIDE_LABEL;
  const value =
    list
      .map(
        (e) =>
          `${e.id} by ${e.by ?? 'Civitai staff'}: ${e.paths.join(', ')}${
            e.unreadable ? ' (could not be read)' : ''
          }`
      )
      .join('; ') + (truncated === true ? '; more unshipped updates were not checked' : '');
  return [{ key: 'platform-updates', heading, value }];
}
