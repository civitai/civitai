import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { BlockScopeList } from './BlockScopeList';
import { blockScopePermissions, groupListingPermissions } from './listingPermissions';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';

/**
 * BlockScopeList — the scope-id list on the moderator's listing preview. This pure-props
 * browser test pins the SENSITIVE-scope emphasis: a sensitive scope gets the reusable
 * "Sensitive" indicator, a normal one does not.
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
 * The tree that lets a long scope id wrap instead of ellipsising: the id and its description are
 * SIBLINGS in a per-scope stack, and the "Sensitive" marker sits in the id's own row. This tier
 * loads no Mantine component styles, so it cannot see an ellipsis itself; it pins the structure.
 */
describe('BlockScopeList — the id owns a line, the description owns the next one', () => {
  const LONG_SCOPE = 'apps:diagnostics:telemetry:aggregate:write:self:secondary:partition';
  const DESCRIBED_SCOPE = 'models:read:self';

  function scopeRows(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="block-scope-row"]'));
  }
  /** The row whose id badge reads exactly `scope` — rows are grouped, so not in input order. */
  function rowFor(scope: string): HTMLElement {
    const row = scopeRows().find(
      (r) => r.querySelector('[data-testid="block-scope-id"]')?.textContent === scope
    );
    if (!row) throw new Error(`no row for ${scope}`);
    return row;
  }

  test('an over-long id renders its COMPLETE text, and the description is its sibling', async () => {
    renderWithProviders(<BlockScopeList scopes={[LONG_SCOPE, DESCRIBED_SCOPE]} />);
    await expect.element(page.getByTestId('block-scope-list')).toBeInTheDocument();

    expect(scopeRows()).toHaveLength(2);
    const longRow = rowFor(LONG_SCOPE);

    const badge = longRow.querySelector('[data-testid="block-scope-id"]');
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
    expect(longRow.children).toHaveLength(2);
    expect(badge!.parentElement).toBe(longRow.children[0]);
    expect(longRow.children[1].textContent).toBe('(no description)');

    // …and a scope WITH a description puts it in the same second slot. Derived from the owner,
    // not retyped: a copied sentence keeps passing after the map's wording changes.
    expect(rowFor(DESCRIBED_SCOPE).children[1].textContent).toBe(
      SCOPE_DESCRIPTIONS[DESCRIBED_SCOPE]
    );
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

/**
 * The moderator's listing preview shows an app's scope ids through this component, so it must
 * group and order them exactly like the store listing's `groupListingPermissions`. The fixture's input order differs from the grouped order at
 * every position, so a flat render in input order cannot pass.
 */
describe('BlockScopeList — grouped and ordered like the store listing', () => {
  const UNKNOWN = 'zz:not-a-real:scope';
  const INPUT = [
    'models:read:self',
    UNKNOWN,
    'apps:storage:shared:write',
    'user:read:self',
    'ai:write:budgeted',
  ];
  const SENSITIVE = ['ai:write:budgeted', 'apps:storage:shared:write'];
  const OTHER = ['user:read:self', 'models:read:self', UNKNOWN];

  const renderedIds = () =>
    Array.from(document.querySelectorAll('[data-testid="block-scope-id"]')).map(
      (el) => el.textContent
    );

  test('renders sensitive first, each group in OAuth-bit order, and drops no scope', async () => {
    renderWithProviders(<BlockScopeList scopes={INPUT} />);
    await expect.element(page.getByText(UNKNOWN)).toBeInTheDocument();

    expect(renderedIds()).toEqual([...SENSITIVE, ...OTHER]);
    // The same answer as the store listing's rule for the same input.
    const grouped = groupListingPermissions(blockScopePermissions(INPUT));
    expect(renderedIds()).toEqual([...grouped.sensitive, ...grouped.other].map((p) => p.id));
  });

  test('each scope sits under its own group heading, the unknown one under "Other"', async () => {
    renderWithProviders(<BlockScopeList scopes={INPUT} />);
    await expect.element(page.getByText(UNKNOWN)).toBeInTheDocument();

    const groupOf = (scope: string) => {
      const badge = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="block-scope-id"]')
      ).find((el) => el.textContent === scope);
      return badge?.closest<HTMLElement>('[role="group"]') ?? null;
    };
    const sensitiveGroup = groupOf(SENSITIVE[0]);
    const otherGroup = groupOf(OTHER[0]);
    expect(sensitiveGroup, 'the sensitive scopes are not in a group').not.toBeNull();
    expect(otherGroup, 'the other scopes are not in a group').not.toBeNull();
    expect(sensitiveGroup).not.toBe(otherGroup);
    for (const s of SENSITIVE) expect(groupOf(s), s).toBe(sensitiveGroup);
    for (const s of OTHER) expect(groupOf(s), s).toBe(otherGroup);

    // The group's accessible name is its visible heading.
    const nameOf = (group: HTMLElement) =>
      document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent;
    expect(nameOf(sensitiveGroup!)).toBe('Sensitive permissions (2)');
    expect(nameOf(otherGroup!)).toBe('Other permissions (3)');
  });

  test('a lone sensitive group is still named, as on the store listing', async () => {
    renderWithProviders(<BlockScopeList scopes={['ai:write:budgeted', 'social:tip:self']} />);
    await expect.element(page.getByText('ai:write:budgeted')).toBeInTheDocument();
    const labels = Array.from(
      document.querySelectorAll('[data-testid="block-scope-group-label"]')
    ).map((el) => el.textContent);
    expect(labels).toEqual(['Sensitive permissions (2)']);
  });

  test('a lone other group is not named', async () => {
    renderWithProviders(<BlockScopeList scopes={['models:read:self', 'user:read:self']} />);
    await expect.element(page.getByText('models:read:self')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="block-scope-group-label"]')).toHaveLength(0);
  });
});
