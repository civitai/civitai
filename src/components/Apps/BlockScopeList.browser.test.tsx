import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { BlockScopeList } from './BlockScopeList';
import { BLOCK_SCOPE_TO_OAUTH_BIT } from '~/shared/constants/block-scope.constants';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';

/**
 * BlockScopeList — the shared block-scope disclosure list used by the
 * install/manage modal AND the run-frame "Permissions & activity" drawer
 * (AppPermissionsActivityDrawer renders granted scopes through this component).
 * This pure-props browser test pins the SENSITIVE-scope emphasis for both
 * surfaces at once: a sensitive granted scope gets the reusable "Sensitive"
 * indicator, a normal one does not.
 */
describe('BlockScopeList — sensitive scope emphasis', () => {
  test('flags a sensitive scope with the "Sensitive" badge and leaves a normal scope unbadged', async () => {
    renderWithProviders(<BlockScopeList scopes={['ai:write:budgeted', 'models:read:self']} />);
    // Both scopes render.
    await expect.element(page.getByText('ai:write:budgeted')).toBeInTheDocument();
    await expect.element(page.getByText('models:read:self')).toBeInTheDocument();
    // Exactly ONE sensitive badge — for the sensitive scope only.
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(1);
  });

  test('renders no sensitive badge when every granted scope is normal', async () => {
    renderWithProviders(<BlockScopeList scopes={['models:read:self', 'user:read:self']} />);
    await expect.element(page.getByText('user:read:self')).toBeInTheDocument();
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(0);
  });

  test('renders the empty label with no badges when there are no scopes', async () => {
    renderWithProviders(<BlockScopeList scopes={[]} emptyLabel="Nothing granted." />);
    await expect.element(page.getByText('Nothing granted.')).toBeInTheDocument();
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(0);
  });
});

/**
 * 🔴 THE STRUCTURE THAT LETS A LONG SCOPE ID SURVIVE, AND WHERE THE PIXELS ARE INSTEAD.
 *
 * The defect was an ellipsised scope id in the ~408px permissions drawer, caused by Mantine's
 * Badge clipping its own label while `wrap="nowrap"` made the description compete for the same
 * axis. Half of that is a LAYOUT fact and is deliberately NOT asserted here: this tier injects
 * `globals.css`'s `:root` block only (24 CSS rules, no Mantine component styles), so the
 * ellipsis does not exist in this document and a `scrollWidth` read would pass against the
 * broken component. The measured arms live in `AppsWideLayout.geometry.test.tsx`
 * ("the over-long scope id renders in FULL and is not clipped"), which loads the real cascade.
 *
 * What IS a fact in any cascade is the tree: the id and its description are SIBLINGS in a
 * per-scope stack rather than children of one row, and the "Sensitive" marker sits in the id's
 * own row. Those are the two things a future refactor would undo.
 */
describe('BlockScopeList — the id owns a line, the description owns the next one', () => {
  // Same string as `AppsWideLayout.geometry.test.tsx`'s `fixture.longScope`, where it is ALSO
  // sized to overflow the 408px drawer — that tier is the one that can see a wrap.
  //
  // 🔴 IT CARRIES ITS OWN CONTROL RATHER THAN RELYING ON THE OTHER FILE'S. The two copies are
  // separate literals, so retuning one — because a real scope grew — would silently leave this
  // one testing an id that fits unaided, which is the exact vacuous pass the geometry file
  // records having hit at 47 chars. `BLOCK_SCOPE_TO_OAUTH_BIT` is the registry every scope is
  // declared in, so this is the defining population and not a remembered list.
  // ⚠️ IN THIS TIER THE LENGTH CANNOT MATTER — there is no cascade, so no ellipsis to escape.
  // The control is here so the two literals cannot desynchronise unnoticed; it buys
  // documentation, not coverage.
  const LONG_SCOPE = 'apps:diagnostics:telemetry:aggregate:write:self:secondary:partition';
  const DESCRIBED_SCOPE = 'models:read:self';

  test('the fixture id exceeds every scope the app actually ships', () => {
    const realIds = Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT);
    expect(
      realIds.length,
      'the scope registry is empty — this control checks nothing'
    ).toBeGreaterThan(5);
    expect(LONG_SCOPE.length).toBeGreaterThan(Math.max(...realIds.map((s) => s.length)));
    // …and the described scope must actually have a description, or the arm below asserts the
    // "(no description)" italic instead of the thing it is named for.
    expect(SCOPE_DESCRIPTIONS[DESCRIBED_SCOPE]).toBeTruthy();
  });

  function scopeRows(): HTMLElement[] {
    const list = document.querySelector('[data-testid="block-scope-list"]');
    if (!list) throw new Error('BlockScopeList rendered no list container');
    return Array.from(list.children) as HTMLElement[];
  }

  test('an over-long id renders its COMPLETE text, and the description is its sibling', async () => {
    renderWithProviders(<BlockScopeList scopes={[LONG_SCOPE, DESCRIBED_SCOPE]} />);
    await expect.element(page.getByTestId('block-scope-list')).toBeInTheDocument();

    const rows = scopeRows();
    expect(rows).toHaveLength(2);

    const badge = rows[0].querySelector('[data-testid="block-scope-id"]');
    // The whole normalised string, never a substring: the failure mode is a TRUNCATION, and a
    // `toContain` on a prefix is satisfied by exactly that.
    expect(badge?.textContent).toBe(LONG_SCOPE);
    // The badge row and the description are two children of the scope's own stack — not one
    // row containing both, which is what made them fight over a single axis.
    //
    // 🔴 `parentElement`, NOT `children[0].contains(badge)`. `Node.contains` is INCLUSIVE OF
    // SELF, so the `contains` form is satisfied when `children[0]` IS the badge — i.e. by the
    // pre-change tree, where the badge was a direct child of the row. Measured: with the
    // `origin/main` shape restored and only the two testids kept, every other assertion in this
    // arm passed too, so the whole thing was green against the defect.
    expect(rows[0].children).toHaveLength(2);
    expect(badge!.parentElement).toBe(rows[0].children[0]);
    expect(rows[0].children[1].textContent).toBe('(no description)');

    // …and a scope WITH a description puts it in the same second slot. Derived from the owner,
    // not retyped: a copied sentence keeps passing after the map's wording changes.
    expect(rows[1].children[1].textContent).toBe(SCOPE_DESCRIPTIONS[DESCRIBED_SCOPE]);
  });

  test('the "Sensitive" marker stays in the scope id\'s OWN row', async () => {
    // Orphaning it onto a line of its own makes it read as an unattributed second scope, which
    // on a permissions disclosure is worse than the truncation this change removed.
    renderWithProviders(<BlockScopeList scopes={['ai:write:budgeted']} />);
    await expect.element(page.getByTestId('sensitive-scope-badge')).toBeInTheDocument();
    const [row] = scopeRows();
    const badgeRow = row.children[0];
    expect(badgeRow.querySelector('[data-testid="block-scope-id"]')?.textContent).toBe(
      'ai:write:budgeted'
    );
    expect(badgeRow.querySelector('[data-testid="sensitive-scope-badge"]')).not.toBeNull();
  });
});
