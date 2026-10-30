import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';

import { renderWithProviders } from '../../../test/component-setup';
import { ListingCollaboratorByline } from '~/components/Apps/ListingCollaboratorByline';

/**
 * The PUBLIC collaborator byline chip row.
 *
 * 🔴 THE POLICY IS SERVER-SIDE. `listDisplayedCollaboratorUserIds` filters
 * `status='accepted'` AND `displayed=true`, and `projectListingDetail` narrows each user
 * to exactly `{id, username, image}` — both pinned in
 * `app-access.service.test.ts` and `app-collaborator.public-projection.test.ts`.
 *
 * What THIS file pins is the seam those two cannot see: that the rendered surface adds no
 * widening of its own and no field beyond the three-key projection ever reaches the DOM.
 * The `AppListingDetailBody` suite pins the anonymous end-to-end view.
 */

describe('ListingCollaboratorByline', () => {
  test('renders one linked chip per collaborator, in the order given', async () => {
    renderWithProviders(
      <ListingCollaboratorByline
        collaborators={[
          { id: 7, username: 'bob', image: null },
          { id: 8, username: 'carol', image: null },
        ]}
      />
    );
    await expect.element(page.getByTestId('apps-listing-collaborator-7')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-listing-collaborator-8')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-collaborator-7').element().getAttribute('href')).toBe(
      '/user/bob'
    );
  });

  /**
   * 🔴 RENDERS WHAT IT IS HANDED, AND NOTHING ELSE. A client-side status/displayed filter
   * here would be a SECOND home for a rule whose only enforceable home is the server (an
   * anonymous reader hitting the API directly never runs this code). The absence of such
   * a filter is the behaviour, so it is asserted: a set the server chose to include is
   * rendered whatever else the caller believes about it.
   */
  test('applies no policy of its own — every supplied chip is rendered', async () => {
    renderWithProviders(
      <ListingCollaboratorByline
        collaborators={[
          { id: 1, username: 'a', image: null },
          { id: 2, username: 'b', image: null },
          { id: 3, username: 'c', image: null },
        ]}
      />
    );
    for (const id of [1, 2, 3]) {
      await expect.element(page.getByTestId(`apps-listing-collaborator-${id}`)).toBeInTheDocument();
    }
  });

  /**
   * 🔴 THE SENTINEL IS LOAD-BEARING, NOT SCAFFOLDING. `locator.elements()` is
   * SYNCHRONOUS — called straight after `renderWithProviders` it returns `[]` before
   * React has committed anything, so a bare "expect 0 elements" passes whatever the
   * component does. Measured: the mutant `chips.length === 0` → `=== -1` (which makes an
   * empty set render the chrome) SURVIVED that form of the test. Awaiting a host element
   * that MUST be in the document proves the tree is committed, so the zero that follows
   * is an observation rather than a race — and the positive control below proves the
   * locator can count to one.
   */
  test('an EMPTY set renders nothing at all — no stray "with" label', async () => {
    renderWithProviders(
      <div data-testid="byline-host">
        <ListingCollaboratorByline collaborators={[]} />
      </div>
    );
    await expect.element(page.getByTestId('byline-host')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-collaborators').elements()).toHaveLength(0);
  });

  test('POSITIVE CONTROL: the same locator counts 1 when the set is non-empty', async () => {
    renderWithProviders(
      <div data-testid="byline-host">
        <ListingCollaboratorByline collaborators={[{ id: 1, username: 'a', image: null }]} />
      </div>
    );
    await expect.element(page.getByTestId('byline-host')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-collaborators').elements()).toHaveLength(1);
  });

  test('a chip with no username is skipped (it cannot be a byline)', async () => {
    renderWithProviders(
      <ListingCollaboratorByline
        collaborators={[
          { id: 4, username: null, image: null },
          { id: 5, username: 'dave', image: null },
        ]}
      />
    );
    // The PRESENT chip is awaited FIRST — it is this test's own proof that the render
    // committed, so the absence asserted after it is real (see the sentinel note above).
    await expect.element(page.getByTestId('apps-listing-collaborator-5')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-collaborator-4').elements()).toHaveLength(0);
  });

  test('a set of ONLY usernameless chips renders nothing', async () => {
    renderWithProviders(
      <div data-testid="byline-host">
        <ListingCollaboratorByline collaborators={[{ id: 6, username: null, image: null }]} />
      </div>
    );
    await expect.element(page.getByTestId('byline-host')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-collaborators').elements()).toHaveLength(0);
  });

  test('the username is URL-encoded into the profile link', async () => {
    renderWithProviders(
      <ListingCollaboratorByline collaborators={[{ id: 9, username: 'a b/c', image: null }]} />
    );
    const chip = page.getByTestId('apps-listing-collaborator-9');
    await expect.element(chip).toBeInTheDocument();
    expect(chip.element().getAttribute('href')).toBe('/user/a%20b%2Fc');
  });
  /**
   * 🔴 REGRESSION: a producer that omits the field entirely must not crash the page.
   * The moderator combined-review preview builds a `ListingDetail`-shaped object without
   * `collaborators`, and the first version of this component threw
   * `Cannot read properties of undefined (reading 'filter')` — which unmounted the whole
   * review modal, not just the byline. Watched red on `CombinedReviewModal.browser.test`
   * before the `?? []`.
   */
  test('an ABSENT collaborators field renders nothing instead of throwing', async () => {
    for (const value of [undefined, null] as const) {
      renderWithProviders(
        <div data-testid="byline-host">
          <ListingCollaboratorByline collaborators={value} />
        </div>
      );
      await expect.element(page.getByTestId('byline-host')).toBeInTheDocument();
      expect(page.getByTestId('apps-listing-collaborators').elements()).toHaveLength(0);
    }
  });
});
