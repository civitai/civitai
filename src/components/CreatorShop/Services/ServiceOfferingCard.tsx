import { Button, Paper, Text } from '@mantine/core';
import { IconPhoto } from '@tabler/icons-react';
import type { ComponentProps, ReactNode } from 'react';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import cardStyles from '~/components/CardTemplates/AspectRatioCard.module.scss';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { serviceTermsLine } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceRatingBadge } from '~/components/CreatorShop/Services/ServiceRatingBadge';
import { ServiceSlotsBadge } from '~/components/CreatorShop/Services/ServiceSlotsBadge';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { NextLink } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useDomainColor } from '~/hooks/useDomainColor';
import type { ProfileImage } from '~/server/selectors/image.selector';
import { Currency } from '~/shared/utils/prisma/enums';

// Owner and storefront rows select different extras; the card reads only these.
type ServiceCoverImage = Pick<
  ProfileImage,
  'id' | 'name' | 'url' | 'nsfwLevel' | 'hash' | 'userId' | 'type' | 'width' | 'height' | 'metadata'
>;

type ServiceCardSeller = ComponentProps<typeof UserAvatar>['user'];

const COVER_ASPECT_RATIO = 4 / 3;

/** Cover tile for an offering with no cover image. Filled in by the same overlays as a cover. */
function NoCover() {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1 bg-gray-2 text-gray-6 dark:bg-dark-6 dark:text-dark-2">
      <IconPhoto size={32} stroke={1.5} />
      <Text size="sm" c="dimmed">
        No cover yet
      </Text>
    </div>
  );
}

/**
 * The blur caption, sized to the cover: a narrow cover has no room for the sentence, so it
 * keeps only "Rated <level>" and the Show button.
 */
function BlurCaption({ level }: { level: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center @container">
      <ImageGuard2.BlurToggle>
        {(toggle) => (
          <div className="flex flex-col items-center gap-2 text-white">
            <Text size="sm" className="hidden shadow-black/50 text-shadow-sm @[240px]:block">
              This image is rated
            </Text>
            <BrowsingLevelBadge
              browsingLevel={level}
              size="lg"
              className="min-w-[32px] text-center shadow shadow-black/30"
            />
            <Button
              className="pointer-events-auto"
              size="compact-sm"
              radius="xl"
              color="gray"
              onClick={toggle}
            >
              Show
            </Button>
          </div>
        )}
      </ImageGuard2.BlurToggle>
    </div>
  );
}

export function ServiceOfferingCard({
  offering,
  seller,
  slotsOpen,
  href,
  footer,
}: {
  offering: Pick<
    ServiceOffering,
    'title' | 'price' | 'deliveryDays' | 'revisionsIncluded' | 'maxNsfwLevel'
  > & { coverImage?: ServiceCoverImage | null };
  /** The /services feed shows whose offering this is; a seller's own shop and profile do not. */
  seller?: ServiceCardSeller;
  slotsOpen?: number | null;
  /** Where the cover and the View button go. */
  href?: string;
  /** Replaces the View button, for a place whose actions are not "View" (Request, Manage). */
  footer?: ReactNode;
}) {
  const domain = useDomainColor();
  const cover = offering.coverImage;

  const header = (
    <div className="flex w-full items-start justify-between gap-2">
      <ServiceRatingBadge rating={offering.maxNsfwLevel} />
      <div className="ml-auto">
        <ServiceSlotsBadge slotsOpen={slotsOpen ?? null} />
      </div>
    </div>
  );
  const price = (
    <CurrencyBadge
      currency={Currency.BUZZ}
      type={domain === 'green' ? 'green' : 'yellow'}
      unitAmount={offering.price}
    />
  );

  return (
    <Paper withBorder radius="md" className="flex h-full flex-col overflow-hidden">
      {cover ? (
        <AspectRatioImageCard
          href={href}
          alt={offering.title}
          aspectRatio={COVER_ASPECT_RATIO}
          image={{ ...cover, metadata: cover.metadata as MixedObject | null }}
          explain={false}
          overlay={({ safe }) => (safe ? null : <BlurCaption level={cover.nsfwLevel} />)}
          header={header}
          footer={price}
        />
      ) : (
        <div className="relative" style={{ aspectRatio: COVER_ASPECT_RATIO }}>
          <NoCover />
          <div className={cardStyles.header}>{header}</div>
          <div className={cardStyles.footer}>{price}</div>
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <Text fw={700} lineClamp={2}>
          {offering.title}
        </Text>
        {seller && <UserAvatar user={seller} withUsername linkToProfile size="xs" />}
        <Text size="sm" c="dimmed">
          {serviceTermsLine(offering)}
        </Text>
        <div className="mt-auto pt-1">
          {footer ??
            (href && (
              <Button component={NextLink} href={href} size="xs" fullWidth>
                View
              </Button>
            ))}
        </div>
      </div>
    </Paper>
  );
}
