import { ActionIcon, Alert, Card, Group, Loader, Text, Title, Tooltip } from '@mantine/core';
import { IconLock, IconSettings, IconShieldCheck } from '@tabler/icons-react';
import { useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { StickerBookSection } from '~/components/StickerBook/StickerBookSection';
import { StickerBookSettingsModal } from '~/components/StickerBook/StickerBookSettingsModal';
import { StickerBookStickers } from '~/components/StickerBook/StickerBookStickers';
import { Currency } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';
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
  const browsingLevel = useBrowsingLevelDebounced();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data, isLoading, isError } = trpc.stickerBook.get.useQuery({ username, browsingLevel });

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

  return (
    <div className="flex flex-col gap-6">
      {access.moderatorOverride && (
        <Alert color="yellow" icon={<IconShieldCheck size={18} />}>
          <Text size="sm">
            {username} has hidden some or all of this. You can see it because you&rsquo;re a
            moderator; other visitors cannot.
          </Text>
        </Alert>
      )}

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Title order={2}>Sticker book</Title>
          <Text size="sm" c="dimmed">
            {isOwner
              ? 'Your stickers, where you have put them, and what people have put on your work.'
              : `Stickers ${username} owns and the images they have been part of.`}
          </Text>
        </div>

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
      </div>

      {access.canViewEarnings && data.earnedBuzz !== null && (
        <Card withBorder p="sm">
          <Group gap={6} wrap="nowrap">
            <CurrencyIcon currency={Currency.BUZZ} size={18} />
            <Text size="sm">
              <Text span fw={700}>
                {numberWithCommas(data.earnedBuzz)} Buzz
              </Text>{' '}
              earned from stickers on {isOwner ? 'your' : 'their'} images
            </Text>
          </Group>
          {/* Said out loud because the number is smaller than what placers paid:
              the creator's share is a split, and a decline pays a fee rather
              than a share. Both are Buzz that reached the account. */}
          <Text size="xs" c="dimmed" mt={4}>
            What actually reached the account, not what placers paid.
          </Text>
        </Card>
      )}

      {access.canViewStickers && !!data.stickers.length && (
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-2">
            <Title order={3}>{isOwner ? 'Your stickers' : `${username}'s stickers`}</Title>
            {isOwner && (
              <Text size="sm" component={Link} href="/shop" c="blue.4">
                Get more in the shop
              </Text>
            )}
          </div>
          <StickerBookStickers
            stickers={data.stickers}
            showQuantities={access.canViewQuantities}
          />
        </section>
      )}

      <StickerBookSection
        title={isOwner ? 'Images you stickered' : `Images ${username} stickered`}
        emptyMessage={
          isOwner
            ? "You haven't had a sticker accepted on anyone else's image yet."
            : 'None yet.'
        }
        items={data.placed}
        countLabel={(count) => `${count} stickers`}
        nameLabel={(names) => (names.length ? `by ${names[0]}${extra(names)}` : null)}
      />

      <StickerBookSection
        title={isOwner ? 'Your images that got stickered' : `${username}'s images that got stickered`}
        emptyMessage={
          isOwner
            ? 'Nobody has put a sticker on your work yet. Accepted placements show up here.'
            : 'None yet.'
        }
        items={data.received}
        countLabel={(count) => `${count} stickers`}
        nameLabel={(names) => (names.length ? `by ${names[0]}${extra(names)}` : null)}
      />

      {nothingYet && isOwner && (
        <Alert color="blue">
          <Text size="sm">
            Nothing in your book yet. Buy a sticker in the{' '}
            <Text component={Link} href="/shop" c="blue.4" inherit>
              shop
            </Text>{' '}
            and put one on an image, or turn stickers on for your own images in the settings above.
          </Text>
        </Alert>
      )}

      {isOwner && (
        <StickerBookSettingsModal opened={settingsOpen} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

/** "+2" rather than a list: a card is one line wide and names are not bounded. */
const extra = (names: string[]) => (names.length > 1 ? ` +${names.length - 1}` : '');
