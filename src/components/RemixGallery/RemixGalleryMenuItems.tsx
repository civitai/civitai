import { Menu } from '@mantine/core';
import { IconArrowBackUp, IconPhotoUp } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink } from '~/components/NextLink/NextLink';
import { useRemixSources } from '~/components/RemixGallery/RemixSourcesList';
import { RemixSourcesModal } from '~/components/RemixGallery/RemixSourcesModal';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * The remix entries in an image's context menu: submit this remix to the
 * galleries it came from, and jump to the image it came from.
 *
 * 🔴 Both query on mount, and that is only affordable because a Mantine
 * `Menu.Dropdown` does not render its children until the menu is opened
 * (`keepMounted` is unset on both `Menu` and `Popover`, and `Transition` renders
 * nothing while unmounted). Moving either of these queries to a component that
 * renders with the CARD asks it once per image in every feed, for a feature
 * 0.2% of images qualify for. Verify that property before lifting them.
 */
export function RemixGalleryMenuItems({
  imageId,
  isOwner,
  published,
}: {
  imageId: number;
  isOwner: boolean;
  /** Only changes what the submit dialog's success message promises. */
  published: boolean;
}) {
  const features = useFeatureFlags();

  if (!features.remixGallery) return null;

  return (
    <>
      {isOwner && <SubmitRemixMenuItem imageId={imageId} published={published} />}
      <ViewOriginalMenuItem imageId={imageId} />
    </>
  );
}

/**
 * Rendered only once the server says this image has somewhere to go, so the menu
 * does not carry an entry that opens a dialog saying "nothing here".
 *
 * The hosts come from the image's own provenance server-side, and the query
 * returns nothing at all for an image that is not the caller's — so `isOwner`
 * above is about not asking, never about the answer.
 */
function SubmitRemixMenuItem({ imageId, published }: { imageId: number; published: boolean }) {
  const { sources } = useRemixSources(imageId);

  if (!sources?.length) return null;

  return (
    <Menu.Item
      leftSection={<IconPhotoUp size={14} stroke={1.5} />}
      onClick={() =>
        dialogStore.trigger({ component: RemixSourcesModal, props: { imageId, published } })
      }
    >
      Submit this remix
    </Menu.Item>
  );
}

/**
 * Jump to the image this one was remixed from.
 *
 * Reads `remixOfIds` — server-VERIFIED provenance only — and never the older
 * client-declared `meta.extra.remixOfId`, matching `ImageRemixOfDetails` rather
 * than the submit card beside it. The two differ on purpose: this link and that
 * card both assert publicly, to any viewer, that one person's image came from
 * another's, and Justin ruled on 2026-08-27 that public attribution may not rest
 * on an unverified claim. The submit card reads both fields because a submission
 * is a candidate handed to a creator who reviews it, not an assertion anyone
 * else sees.
 *
 * The cost is real and known: roughly half of all remixes carry only the old
 * field and get no link. That is the accepted trade, not a gap to close.
 */
function ViewOriginalMenuItem({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });

  // The first source, not a submenu. Every remix in a 24h prod sample had
  // exactly one (101 of 101); the detail page's "Remixed From" card is where a
  // multi-source image shows all of them.
  const [sourceId] = data?.remixOfIds ?? [];
  if (!sourceId) return null;

  return (
    <Menu.Item
      component={NextLink}
      href={`/images/${sourceId}`}
      leftSection={<IconArrowBackUp size={14} stroke={1.5} />}
    >
      View original
    </Menu.Item>
  );
}
