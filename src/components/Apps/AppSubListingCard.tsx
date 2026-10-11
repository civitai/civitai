import { Anchor, Avatar, Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import { IconExternalLink, IconEye, IconPlayerPlay } from '@tabler/icons-react';
import Link from 'next/link';
import { ListingCover } from '~/components/Apps/AppListingCard';
import { TruncatedText } from '~/components/Apps/AppListingTruncate';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import {
  LISTING_ACTION_ROW_HEIGHT_PX,
  LISTING_ACTION_ROW_PT_PX,
  LISTING_CARD_TITLE_LINES,
  LISTING_CARD_TITLE_LINE_HEIGHT,
  LISTING_CARD_TITLE_MIN_HEIGHT,
} from '~/components/Apps/appListingCardGeometry';
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

/** A store card for an item inside an app, badged with the app it lives in. */
export function AppSubListingCard({ card, canOpenPage = false }: AppSubListingCardProps) {
  const href = getSubListingHref(card, canOpenPage);
  const parentHref = getListingDetailHref(card.parent.slug);
  const title = (
    <TruncatedText
      size="xl"
      fw={700}
      lh={LISTING_CARD_TITLE_LINE_HEIGHT}
      c="white"
      clampLines={LISTING_CARD_TITLE_LINES}
      tooltipLabel={card.name}
      style={{ minHeight: LISTING_CARD_TITLE_MIN_HEIGHT }}
    >
      {card.name}
    </TruncatedText>
  );
  return (
    <Card
      padding="md"
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
      <Stack gap="sm" h="100%" pt="sm">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Badge
            component={Link}
            href={parentHref}
            variant="light"
            color="gray"
            size="sm"
            radius="sm"
            leftSection={
              card.parent.iconUrl ? (
                <Avatar src={card.parent.iconUrl} alt="" size={14} radius="xs" />
              ) : undefined
            }
            style={{ cursor: 'pointer', textTransform: 'none', minWidth: 0 }}
            data-testid="apps-sub-listing-parent-chip"
          >
            in {card.parent.name}
          </Badge>
        </Group>
        {card.external ? (
          <Anchor
            href={href}
            {...EXTERNAL_LINK_PROPS}
            underline="hover"
            c="inherit"
            style={{ minWidth: 0 }}
          >
            {title}
          </Anchor>
        ) : (
          <Anchor
            component={Link}
            href={href}
            underline="hover"
            c="inherit"
            style={{ minWidth: 0 }}
          >
            {title}
          </Anchor>
        )}
        {card.creator.username && (
          <Anchor
            component={Link}
            href={`/user/${encodeURIComponent(card.creator.username)}`}
            size="sm"
            c="dimmed"
            data-testid="apps-sub-listing-author"
          >
            by {card.creator.username}
          </Anchor>
        )}
        {card.tagline && (
          <Text size="sm" c="dimmed" className="line-clamp-3">
            {card.tagline}
          </Text>
        )}
        <Group mt="auto" pt={LISTING_ACTION_ROW_PT_PX} mih={LISTING_ACTION_ROW_HEIGHT_PX}>
          {card.external ? (
            <Button
              component="a"
              href={href}
              {...EXTERNAL_LINK_PROPS}
              size="sm"
              variant="light"
              rightSection={<IconExternalLink size={16} />}
              style={{ flexGrow: 1 }}
              data-testid="apps-sub-listing-cta"
            >
              Play
            </Button>
          ) : (
            <Button
              component={Link}
              href={href}
              size="sm"
              variant="light"
              leftSection={canOpenPage ? <IconPlayerPlay size={16} /> : <IconEye size={16} />}
              style={{ flexGrow: 1 }}
              data-testid="apps-sub-listing-cta"
            >
              {canOpenPage ? 'Open' : `View ${card.parent.name}`}
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
