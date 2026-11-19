/**
 * APP HIBERNATE — LINEAGE: which archive a sandbox was woken from, as this browser saw it wake.
 * civitai keeps a sleeping app's record after a wake (it is that sandbox's lineage), so a record
 * of app X and a live sandbox of X can both exist. Only a sandbox woken FROM the record (its seed's
 * sha256 is the record's) may take that record with it when the user deletes it; any other X (one
 * made empty while X slept, or one woken on another device, which this browser cannot vouch for)
 * leaves the record alone, for the Sleeping row's own Delete.
 *
 * Kept in localStorage per user, so a reload keeps it. Unreadable storage means no lineage, which
 * is the safe answer: nothing is deleted on its strength.
 */

const KEY = (userId: number | null) => `app-hibernate:lineage:${userId ?? 'anon'}`;
/** Old entries go first; a user wakes far fewer apps than this. */
const MAX_ENTRIES = 200;

function read(userId: number | null): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY(userId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Records that sandbox `name` was woken from the archive `sha256`. */
export function rememberLineage(userId: number | null, name: string, sha256: string): void {
  try {
    const entries = Object.entries(read(userId)).filter(([key]) => key !== name);
    entries.push([name, sha256]);
    localStorage.setItem(
      KEY(userId),
      JSON.stringify(Object.fromEntries(entries.slice(-MAX_ENTRIES)))
    );
  } catch {
    // No storage: the sandbox simply has no lineage here.
  }
}

/** The archive sandbox `name` was woken from on this browser, or `null`. */
export function lineageOf(userId: number | null, name: string): string | null {
  const sha = read(userId)[name];
  return typeof sha === 'string' ? sha : null;
}
