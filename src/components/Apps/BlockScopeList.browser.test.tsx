import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { BlockScopeList } from './BlockScopeList';

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
    renderWithProviders(
      <BlockScopeList scopes={['ai:write:budgeted', 'models:read:self']} />
    );
    // Both scopes render.
    await expect.element(page.getByText('ai:write:budgeted')).toBeInTheDocument();
    await expect.element(page.getByText('models:read:self')).toBeInTheDocument();
    // Exactly ONE sensitive badge — for the sensitive scope only.
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(1);
  });

  test('renders no sensitive badge when every granted scope is normal', async () => {
    renderWithProviders(
      <BlockScopeList scopes={['models:read:self', 'user:read:self']} />
    );
    await expect.element(page.getByText('user:read:self')).toBeInTheDocument();
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(0);
  });

  test('renders the empty label with no badges when there are no scopes', async () => {
    renderWithProviders(<BlockScopeList scopes={[]} emptyLabel="Nothing granted." />);
    await expect.element(page.getByText('Nothing granted.')).toBeInTheDocument();
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(0);
  });
});
