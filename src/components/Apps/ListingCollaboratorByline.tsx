import { Anchor, Avatar, Group, Text } from '@mantine/core';
import Link from 'next/link';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';

/**
 * The PUBLIC collaborator byline on the app store detail page.
 *
 * 🔴 THIS COMPONENT APPLIES NO POLICY, AND MUST NOT. Which people appear here is decided
 * entirely server-side by `listDisplayedCollaboratorUserIds`, which filters
 * `status = 'accepted'` (CONSENT — a pending invitee must never appear publicly, or
 * anyone could attach a stranger's name to their app by inviting them) AND
 * `displayed = true` (the byline OPT-OUT). The DTO reaching this component is already the
 * filtered set, projected to exactly `{id, username, image}` by the same `creatorChip`
 * allowlist as the creator.
 *
 * Adding a client-side filter here would create a SECOND place the rule lives, and the
 * one that matters — an anonymous reader hitting the API directly — would still be the
 * server's. Adding a client-side WIDENING (rendering a row this list did not contain)
 * would be a leak. So: render what you are handed, and nothing else.
 *
 * A chip with no `username` is skipped: it cannot be linked to a profile, and a nameless
 * avatar is not a byline.
 */
export type ListingCollaboratorChip = {
  id: number;
  username: string | null;
  image: string | null;
};

export function ListingCollaboratorByline({
  collaborators,
}: {
  /**
   * 🔴 OPTIONAL AT RUNTIME EVEN THOUGH `ListingDetail.collaborators` IS DECLARED
   * REQUIRED, and this is a measured defect rather than defensive habit. Not every
   * producer of a `ListingDetail`-shaped object goes through `projectListingDetail`
   * (which defaults the field to `[]`): the moderator combined-review preview builds one
   * directly, so this component was handed `undefined` and threw
   * `Cannot read properties of undefined (reading 'filter')` — taking the WHOLE review
   * modal down with it, because a crashing child unmounts its ancestors. Caught by the
   * pre-existing `CombinedReviewModal.browser.test.tsx`, which went red on this change.
   *
   * A byline is decoration. It must never be able to blank the page it decorates, and a
   * required TYPE is not a runtime guarantee about a value that crossed a cast.
   */
  collaborators: ListingCollaboratorChip[] | null | undefined;
}) {
  const chips = (collaborators ?? []).filter((c) => !!c.username);
  if (chips.length === 0) return null;
  return (
    <Group gap={6} wrap="wrap" data-testid="apps-listing-collaborators">
      <Text size="sm" c="dimmed">
        with
      </Text>
      {chips.map((chip) => {
        const username = chip.username as string;
        const avatarSrc = chip.image ? getEdgeUrl(chip.image, { width: 64 }) : undefined;
        return (
          <Anchor
            key={chip.id}
            component={Link}
            href={`/user/${encodeURIComponent(username)}`}
            underline="hover"
            c="dimmed"
            data-testid={`apps-listing-collaborator-${chip.id}`}
          >
            <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
              <Avatar src={avatarSrc} alt="" radius="xl" size={20} style={{ flexShrink: 0 }}>
                {username.charAt(0).toUpperCase()}
              </Avatar>
              <Text size="sm" c="dimmed" lineClamp={1}>
                {username}
              </Text>
            </Group>
          </Anchor>
        );
      })}
    </Group>
  );
}
