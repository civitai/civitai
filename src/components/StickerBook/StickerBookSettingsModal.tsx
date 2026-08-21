import { Divider, Modal, Stack, Switch } from '@mantine/core';
import { PlacementSpaceSection } from '~/components/Account/PlacementSpaceSection';
import { useCurrentUserSettings, useMutateUserSettings } from '~/components/UserSettings/hooks';
import { trpc } from '~/utils/trpc';

/**
 * The sticker book's settings, behind a gear rather than pinned to the top of
 * the page.
 *
 * Justin's call in the design session: the card is the same every visit and the
 * page is not about it — "having this at the top every time could be annoying".
 * So the tab opens on the collection and the placement rules are one press away.
 *
 * `PlacementSpaceSection` is rendered as-is rather than reimplemented. It is the
 * same control set the account page carries, and the price cap, the free-slot
 * ceiling and the "unset price tracks the platform default" rule all live inside
 * it — a second copy of those would be a second set of money rules to keep
 * correct.
 */
export function StickerBookSettingsModal({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const settings = useCurrentUserSettings();
  const utils = trpc.useUtils();
  // Both, and neither is optional: the book's payload is what withholds the
  // content, and the profile's `stickerBookHidden` is what withholds the tab. A
  // creator flipping a switch and seeing nothing change would flip it back.
  const mutate = useMutateUserSettings({
    onSuccess: async () => {
      await Promise.all([utils.stickerBook.invalidate(), utils.userProfile.invalidate()]);
    },
  });

  // The stored values are opt-OUTS, and the switches ask the opposite question,
  // so both are inverted here rather than in the payload: an account that has
  // never opened this modal has no keys at all, and a switch bound to a missing
  // key must read as visible.
  const bookVisible = settings.hideStickerBook !== true;
  const stickersVisible = settings.hidePurchasedStickers !== true;

  return (
    <Modal opened={opened} onClose={onClose} title="Sticker settings" size="lg">
      <Stack gap="md">
        <Divider label="Who can see your sticker book" />

        <Switch
          checked={bookVisible}
          onChange={(event) => mutate.mutate({ hideStickerBook: !event.currentTarget.checked })}
          label="Show my sticker book on my profile"
          description="Off hides the whole tab from visitors. Moderators can still see it."
        />

        <Switch
          checked={stickersVisible}
          // Independent of the switch above rather than nested under it: a
          // creator whose book is hidden still has a stored answer to this one,
          // and turning the book back on must not silently republish a
          // collection they had chosen to keep private.
          onChange={(event) =>
            mutate.mutate({ hidePurchasedStickers: !event.currentTarget.checked })
          }
          label="Show the stickers I own"
          description="How many uses you have left is only ever shown to you."
        />

        <PlacementSpaceSection />
      </Stack>
    </Modal>
  );
}
