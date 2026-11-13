import { listAppRoles } from '@civitai/db-queries/page-access';
import { APP, SUPER_ROLE, isStorableRole, type Role } from './access';
import { dbRead } from './db';

export const NO_ROLE_CATALOGUE =
  'Could not read the role list from the auth hub. Try again shortly.';

// Column order for `/admin`, and nothing else. The matrix is read left to right as ascending trust, and a
// column's position is the only thing telling one unlabelled checkbox from the next — ordering by id put
// the newest role leftmost and inverted that, so "the last column" silently changed which role it meant.
// This is NOT the role list: membership comes entirely from the hub, and anything absent here sorts after,
// so a role created there still appears without a deploy — after these, alphabetically, which is where
// the single-purpose roles (membership codes, payroll, scan labels) belong.
//
// One ladder per team, each ascending. Stale until 2026-10-16: it named volunteer/staff/senior, which no
// longer exist in the hub, so every column fell through to alphabetical and the two ladders interleaved
// with the single-purpose roles. `grantableRoles` now logs a name here the hub does not have.
// `cm-medium-access` is left out deliberately: it is being retired from the moderator roles.
const COLUMN_ORDER: readonly Role[] = [
  'moderator:mod-medium-access',
  'moderator:mod-high-access',
  'moderator:cm-high-access',
];

function byTrust(a: Role, b: Role): number {
  const rankA = COLUMN_ORDER.indexOf(a);
  const rankB = COLUMN_ORDER.indexOf(b);
  if (rankA === rankB) return a.localeCompare(b);
  return (rankA < 0 ? COLUMN_ORDER.length : rankA) - (rankB < 0 ? COLUMN_ORDER.length : rankB);
}

/**
 * The roles `/admin` may grant, read from the auth hub's catalogue rather than a list kept here — a role
 * created in the hub has to appear on this screen without a deploy.
 *
 * `null` when the read cannot be trusted, never a bare empty list. The caller filters stored grants to
 * whatever comes back, so an unreadable catalogue renders a matrix stating that nobody holds anything
 * while the gate carries on granting. The hub always holds the super role, so its absence means the read
 * is wrong — empty, or against the wrong database or app prefix — rather than that there is nothing to
 * grant. Testing the pre-filter list instead let a catalogue of exactly the super role through, which is
 * that same blank matrix.
 *
 * Presentation is the caller's, deliberately: `error(503)` is right for a load and destroys the operator's
 * unsaved ticks when thrown from the save action, so this returns rather than throwing.
 *
 * Read per request rather than cached, for the reason `readPageAccessGrants` gives: `/admin` is the one
 * screen that edits grants, and it cannot tolerate a staleness window.
 */
export async function grantableRoles(): Promise<Role[] | null> {
  try {
    const all = await listAppRoles(dbRead, APP);
    if (!all.includes(SUPER_ROLE)) return null;
    const missing = COLUMN_ORDER.filter((role) => !all.includes(role));
    if (missing.length)
      console.warn(`[roles] COLUMN_ORDER names roles the hub does not have: ${missing.join(', ')}`);
    return all.filter(isStorableRole).sort(byTrust);
  } catch (e) {
    console.error('[roles] could not read the role catalogue from the auth hub', e);
    return null;
  }
}
