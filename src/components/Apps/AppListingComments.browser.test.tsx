import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * Comments key on the listing's integer `serialId`, not its text id: a section keyed on anything
 * else reads another listing's comments, or none.
 */

const mocks = vi.hoisted(() => ({
  sections: [] as Array<{ entityType: unknown; entityId: unknown; ownerId: unknown }>,
}));

vi.mock('~/components/CommentsV3/CommentSection', () => ({
  CommentSection: (props: { entityType: unknown; entityId: unknown; ownerId: unknown }) => {
    mocks.sections.push({
      entityType: props.entityType,
      entityId: props.entityId,
      ownerId: props.ownerId,
    });
    return <div data-testid="comment-section" />;
  },
}));

import { AppListingComments } from './AppListingComments';

beforeEach(() => {
  mocks.sections.length = 0;
});

describe('AppListingComments', () => {
  test('an approved listing mounts its comments on its serialId, with the developer as owner', async () => {
    renderWithProviders(<AppListingComments serialId={42} ownerUserId={7} />);

    await expect.element(page.getByTestId('comment-section')).toBeInTheDocument();
    expect(mocks.sections).toEqual([{ entityType: 'appListing', entityId: 42, ownerId: 7 }]);
  });

  test.each([null, undefined])('renders nothing without a serialId (%s)', async (serialId) => {
    renderWithProviders(<AppListingComments serialId={serialId} ownerUserId={7} />);
    expect(page.getByTestId('app-listing-comments').query()).toBeNull();
    expect(mocks.sections).toHaveLength(0);
  });
});
