import { Anchor, Avatar, Badge, Button, Card, Divider, Group, Stack, Text } from '@mantine/core';
import { IconExternalLink, IconEye, IconPlayerPlay } from '@tabler/icons-react';
import Link from 'next/link';
import { ListingCover } from '~/components/Apps/AppListingCard';
import { TruncatedText } from '~/components/Apps/AppListingTruncate';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import {
  LISTING_CARD_CREATOR_AVATAR_PX,
  LISTING_CARD_FOOTER_HEIGHT_PX,
  LISTING_CARD_TITLE_LINE_HEIGHT,
} from '~/components/Apps/appListingCardGeometry';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { SubListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * Where a sub-listing card goes. An off-site item opens on its platform. An on-site item opens
 * in the parent app when the viewer can open app pages, otherwise the parent's store page (the
 * run route would 404 for them).
 */
export function getSubListingHref(card: SubListingCard, canOpenPage: boolean): string {
  if (card.external) return card.runHref;
  return canOpenPage ? card.runHref : getListingDetailHref(card.parent.slug);
}

const EXTERNAL_LINK_PROPS = { target: '_blank', rel: 'noopener noreferrer' } as const;

export interface AppSubListingCardProps {
  card: SubListingCard;
  canOpenPage?: boolean;
}

/**
 * A store card for an item inside an app, laid out like `AppListingCard`: the whole card is the
 * title link, Open sits right of the title (filled, glyph trailing the label), a full-width
 * divider, then the creator as the shared `UserAvatar` (hover card). It has no icon of its own,
 * so the title starts at the left edge; the app it lives in is a chip under the title.
 */
export function AppSubListingCard({ card, canOpenPage = false }: AppSubListingCardProps) {
  const href = getSubListingHref(card, canOpenPage);
  const parentHref = getListingDetailHref(card.parent.slug);
  const opensItem = card.external || canOpenPage;
  const title = (
    <TruncatedText
      size="xl"
      fw={700}
      lh={LISTING_CARD_TITLE_LINE_HEIGHT}
      c="light-dark(var(--mantine-color-dark-9), var(--mantine-color-white))"
      className="relative z-10"
      tooltipLabel={card.name}
    >
      {card.name}
    </TruncatedText>
  );
  const stretched = "after:absolute after:inset-0 after:content-['']";
  const glyph = card.external ? (
    <IconExternalLink size={14} />
  ) : canOpenPage ? (
    <IconPlayerPlay size={14} />
  ) : (
    <IconEye size={14} />
  );
  const ctaProps = {
    size: 'compact-sm',
    variant: 'filled',
    className: 'relative z-10',
    style: { flexShrink: 0 },
    rightSection: glyph,
    'data-testid': 'apps-sub-listing-cta',
  } as const;
  return (
    <Card
      padding={0}
      radius={0}
      className="h-full rounded-md"
      data-testid="apps-sub-listing-card"
      data-sub-listing-id={card.id}
    >
      <ListingCover
        coverUrl={card.coverUrl}
        category={card.category}
        name={card.name}
        slug={card.parent.slug}
      />
      <Stack gap="xs" h="100%" px="md" pt="sm" pb="sm">
        <Group gap="sm" wrap="nowrap" align="center" style={{ minWidth: 0 }}>
          {card.external ? (
            <Anchor
              href={href}
              {...EXTERNAL_LINK_PROPS}
              underline="hover"
              c="inherit"
              className={stretched}
              style={{ minWidth: 0, flex: 1 }}
            >
              {title}
            </Anchor>
          ) : (
            <Anchor
              component={Link}
              href={href}
              underline="hover"
              c="inherit"
              className={stretched}
              style={{ minWidth: 0, flex: 1 }}
            >
              {title}
            </Anchor>
          )}
          {card.external ? (
            <Button component="a" href={href} {...EXTERNAL_LINK_PROPS} {...ctaProps}>
              Open
            </Button>
          ) : (
            <Button component={Link} href={href} {...ctaProps}>
              {opensItem ? 'Open' : 'View'}
            </Button>
          )}
        </Group>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Badge
            component={Link}
            href={parentHref}
            variant="light"
            color="gray"
            size="lg"
            radius="sm"
            className="relative z-10"
            leftSection={
              card.parent.iconUrl ? (
                <Avatar src={card.parent.iconUrl} alt="" size={18} radius="xs" />
              ) : undefined
            }
            style={{ cursor: 'pointer', textTransform: 'none', minWidth: 0 }}
            data-testid="apps-sub-listing-parent-chip"
          >
            in {card.parent.name}
          </Badge>
        </Group>
        {card.tagline && (
          <Text size="sm" c="dimmed" className="line-clamp-3">
            {card.tagline}
          </Text>
        )}
        <Divider
          mt="auto"
          style={{ marginInline: 'calc(var(--mantine-spacing-md) * -1)' }}
          data-testid="apps-sub-listing-divider"
        />
        <Group mih={LISTING_CARD_FOOTER_HEIGHT_PX} justify="flex-end" wrap="nowrap">
          {card.creator.username && (
            <div className="relative z-10 min-w-0 shrink" data-testid="apps-sub-listing-author">
              <UserAvatar
                user={{
                  id: card.creator.id,
                  username: card.creator.username,
                  image: card.creator.image,
                }}
                withUsername
                linkToProfile
                size="xs"
                avatarSize={LISTING_CARD_CREATOR_AVATAR_PX}
                textSize="xs"
              />
            </div>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
