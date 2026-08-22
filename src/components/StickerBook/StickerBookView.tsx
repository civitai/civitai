import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowRight,
  IconEye,
  IconEyeOff,
  IconLock,
  IconPhoto,
  IconSettings,
  IconShieldCheck,
  IconSticker,
} from '@tabler/icons-react';
import { useState } from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { StickerBookBand, StickerBookSection } from '~/components/StickerBook/StickerBookSection';
import { StickerBookSettingsModal } from '~/components/StickerBook/StickerBookSettingsModal';
import { StickerBookStickers } from '~/components/StickerBook/StickerBookStickers';
import { stickerBookSectionCopy } from '~/components/StickerBook/sticker-book.util';
import { Currency } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';
import { trpc } from '~/utils/trpc';

/**
 * One creator's sticker activity in one place: what they own, what they have
 * stickered, and what of theirs has been stickered.
 *
 * 🔴 NOTHING HERE DECIDES WHAT MAY BE SEEN. The two visibility toggles, the
 * moderator override and the owner-only quantities are all resolved on the
 * server, and the withheld halves never arrive — this component reads `access`
 * to choose what to DRAW, not to choose what to withhold. A page that hid a
 * section it had already been sent would be a privacy control one fetch away
 * from being wrong.
 */
export function StickerBookView({ username }: { username: string }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const revealed = useStickerRevealStore((state) => state.revealed);
  const toggleReveal = useStickerRevealStore((state) => state.toggle);
  const { data, isLoading, isError } = trpc.stickerBook.get.useQuery({ username });

  if (isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );

  if (isError || !data)
    return (
      <Alert color="red">
        <Text size="sm">Couldn&rsquo;t load this sticker book. Refresh to try again.</Text>
      </Alert>
    );

  const { access, isOwner } = data;

  if (!access.canViewBook)
    return (
      <Alert color="gray" icon={<IconLock size={18} />}>
        <Text size="sm">{username} keeps their sticker book private.</Text>
      </Alert>
    );

  const nothingYet = !data.placed.length && !data.received.length && !data.stickers.length;
  const bookHref = `/user/${username}/sticker-book`;
  const placedCopy = stickerBookSectionCopy('placer', { username, isOwner });
  const receivedCopy = stickerBookSectionCopy('owner', { username, isOwner });

  return (
    <div className="flex flex-col">
      {access.moderatorOverride && (
        <Alert color="yellow" icon={<IconShieldCheck size={18} />} mb="md">
          <Text size="sm">
            {username} has hidden some or all of this. You can see it because you&rsquo;re a
            moderator; other visitors cannot.
          </Text>
        </Alert>
      )}

      {/* The shop page's header shape: an icon, the creator's name for the thing,
          and the one number worth stating — with no page title above it, because
          no other profile tab carries one. */}
      <Group justify="space-between" align="flex-start" wrap="nowrap" py="md">
        <Group gap="md" align="center" wrap="nowrap" className="min-w-0">
          <ThemeIcon size={48} radius="xl" variant="light" color="yellow">
            <IconSticker size={28} />
          </ThemeIcon>
          <Stack gap={2} className="min-w-0">
            <Title order={1} size="h2">
              {username}&apos;s Sticker Book
            </Title>
            {access.canViewEarnings && data.earnedBuzz !== null ? (
              <Group gap={4} wrap="nowrap">
                <CurrencyIcon currency={Currency.BUZZ} size={16} />
                <Text size="sm">
                  <Text span fw={700}>
                    {numberWithCommas(data.earnedBuzz)} Buzz
                  </Text>{' '}
                  earned from stickers on {isOwner ? 'your' : 'their'} images
                </Text>
              </Group>
            ) : (
              <Text size="sm" c="dimmed">
                {isOwner
                  ? 'Your stickers, where you have put them, and what people have put on your work.'
                  : `Stickers ${username} owns and the images they have been part of.`}
              </Text>
            )}
          </Stack>
        </Group>

        <Group gap="xs" wrap="nowrap">
          {/* The page's reveal control. The cards' own chips are hidden here —
              they were squeezing the reaction counts at this card width — and the
              reveal preference is sticky and site-wide, so without one control
              somewhere a book of stickered images draws no stickers and offers
              no way to turn them on. */}
          <Tooltip label={revealed ? 'Hide stickers on all images' : 'Show stickers on all images'}>
            <ActionIcon
              variant={revealed ? 'light' : 'default'}
              color={revealed ? 'yellow' : undefined}
              size="lg"
              onClick={toggleReveal}
              aria-label={revealed ? 'Hide stickers' : 'Show stickers'}
            >
              {revealed ? <IconEye size={18} /> : <IconEyeOff size={18} />}
            </ActionIcon>
          </Tooltip>

          {isOwner && (
            <Tooltip label="Sticker settings">
              <ActionIcon
                variant="default"
                size="lg"
                onClick={() => setSettingsOpen(true)}
                aria-label="Manage sticker placement settings"
              >
                <IconSettings size={18} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>

      {access.canViewStickers && !!data.stickers.length && (
        <StickerBookBand
          title={isOwner ? 'Your stickers' : `${username}'s stickers`}
          icon={<IconSticker size={24} />}
          shaded
          action={
            isOwner && (
              // Same slot as the sections' "View all", and the same button, so
              // the two bands' actions line up rather than one sitting under its
              // own content.
              <Button
                component={Link}
                href="/shop"
                h={34}
                variant="subtle"
                rightSection={<IconArrowRight size={16} />}
              >
                <Text inherit>Get more in the shop</Text>
              </Button>
            )
          }
        >
          {/* In a panel rather than loose on the page: a wrapping row of small
              artwork with nothing containing it reads as debris between two
              bands of cards. */}
          <Card withBorder p="md">
            <StickerBookStickers
              stickers={data.stickers}
              showQuantities={access.canViewQuantities}
            />
          </Card>
        </StickerBookBand>
      )}

      <StickerBookSection
        title={placedCopy.title}
        icon={<IconSticker size={24} />}
        emptyMessage={placedCopy.empty}
        items={data.placed}
        side="placer"
        viewAllHref={`${bookHref}?view=placer`}
      />

      <StickerBookSection
        title={receivedCopy.title}
        icon={<IconPhoto size={24} />}
        emptyMessage={receivedCopy.empty}
        items={data.received}
        side="owner"
        viewAllHref={`${bookHref}?view=owner`}
        shaded
      />

      {nothingYet && isOwner && (
        <Alert color="blue" mt="md">
          <Text size="sm">
            Nothing in your book yet. Buy a sticker in the{' '}
            <Text component={Link} href="/shop" c="blue.4" inherit>
              shop
            </Text>{' '}
            and put one on an image, or turn stickers on for your own images from the gear above.
          </Text>
        </Alert>
      )}

      {isOwner && (
        <StickerBookSettingsModal opened={settingsOpen} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
