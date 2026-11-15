import { Button, Paper, Text } from '@mantine/core';
import { IconPhoto } from '@tabler/icons-react';
import type { ComponentProps, ReactNode } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import cardStyles from '~/components/CardTemplates/AspectRatioCard.module.scss';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { serviceTermsLine } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceRatingBadge } from '~/components/CreatorShop/Services/ServiceRatingBadge';
import { ServiceOfferingMenu } from '~/components/CreatorShop/Services/ServiceOfferingMenu';
import { ServiceRequestModal } from '~/components/CreatorShop/Services/deals/ServiceRequestModal';
import { ServiceSlotsBadge } from '~/components/CreatorShop/Services/ServiceSlotsBadge';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { NextLink } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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

/**
 * Whether ImageGuard draws its own level chip on the cover: always while blurred, and on a
 * revealed cover only for its owner or a moderator. Where it does, ours would be a second one.
 */
export function coverShowsLevelChip({
  safe,
  isModerator,
  viewerId,
  coverUserId,
}: {
  safe?: boolean;
  isModerator?: boolean;
  viewerId?: number;
  coverUserId?: number;
}) {
  return !safe || !!isModerator || (viewerId != null && viewerId === coverUserId);
}

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
            <div className="flex items-center gap-2 @[300px]:flex-col">
              <Text size="sm" className="shadow-black/50 text-shadow-sm @[300px]:hidden">
                Rated
              </Text>
              <Text size="sm" className="hidden shadow-black/50 text-shadow-sm @[300px]:block">
                This image is rated
              </Text>
              <BrowsingLevelBadge
                browsingLevel={level}
                size="lg"
                className="min-w-[32px] text-center shadow shadow-black/30"
              />
            </div>
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
  sellerId,
  sellerUsername,
  slotsOpen,
  href,
  canRequest = true,
  extra,
}: {
  offering: Pick<
    ServiceOffering,
    'id' | 'title' | 'description' | 'price' | 'deliveryDays' | 'revisionsIncluded' | 'maxNsfwLevel'
  > & { coverImage?: ServiceCoverImage | null };
  /** The /services feed shows whose offering this is; a seller's own shop and profile do not. */
  seller?: ServiceCardSeller;
  sellerId: number;
  sellerUsername: string;
  slotsOpen?: number | null;
  /** Where the cover goes: the offering on its seller's storefront. Unset on the storefront itself. */
  href?: string;
  /** False on a shop that is not published: a buyer's request would answer "Shop not found". */
  canRequest?: boolean;
  /** Under the primary action; the storefront puts the owner's open-request shortcut here. */
  extra?: ReactNode;
}) {
  const domain = useDomainColor();
  const cover = offering.coverImage;

  const currentUser = useCurrentUser();
  const isOwner = !!currentUser && currentUser.id === sellerId;
  const full = slotsOpen === 0;
  const header = (hideRating = false) => (
    <div className="flex w-full items-start justify-between gap-2">
      <div>{!hideRating && <ServiceRatingBadge rating={offering.maxNsfwLevel} />}</div>
      <ServiceOfferingMenu
        offering={offering}
        isOwner={isOwner}
        isModerator={!!currentUser?.isModerator}
      />
    </div>
  );
  const price = (
    <div className="flex w-full items-end justify-between gap-2">
      <div className="rounded-full bg-black/60 backdrop-blur-sm">
        <CurrencyBadge
          currency={Currency.BUZZ}
          type={domain === 'green' ? 'green' : 'yellow'}
          unitAmount={offering.price}
        />
      </div>
      <div className="rounded-sm bg-black/60 backdrop-blur-sm">
        <ServiceSlotsBadge slotsOpen={slotsOpen ?? null} />
      </div>
    </div>
  );

  return (
    <Paper
      withBorder
      radius="md"
      className="flex h-full flex-col overflow-hidden"
      data-testid="service-offering-card"
    >
      {cover ? (
        <AspectRatioImageCard
          href={href}
          alt={offering.title}
          aspectRatio={COVER_ASPECT_RATIO}
          image={{ ...cover, metadata: cover.metadata as MixedObject | null }}
          explain={false}
          overlay={({ safe }) => (safe ? null : <BlurCaption level={cover.nsfwLevel} />)}
          header={({ safe }) =>
            header(
              coverShowsLevelChip({
                safe,
                isModerator: currentUser?.isModerator,
                viewerId: currentUser?.id,
                coverUserId: cover.userId,
              })
            )
          }
          footer={price}
        />
      ) : (
        <div className="relative" style={{ aspectRatio: COVER_ASPECT_RATIO }}>
          <NoCover />
          {href && (
            <NextLink href={href} className="absolute inset-0" aria-label={offering.title} />
          )}
          <div className={cardStyles.header}>{header()}</div>
          <div className={cardStyles.footer}>{price}</div>
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <Text
          fw={700}
          lineClamp={2}
          {...(href ? { component: NextLink, href, className: 'hover:underline' } : {})}
        >
          {offering.title}
        </Text>
        {seller && <UserAvatar user={seller} withUsername linkToProfile size="xs" />}
        <Text size="sm" c="dimmed">
          {serviceTermsLine(offering)}
        </Text>
        <div className="mt-auto flex flex-col gap-2 pt-1">
          {isOwner ? (
            <Button
              component={NextLink}
              href={`/user/${sellerUsername}/shop/manage?tab=services`}
              variant="default"
              fullWidth
            >
              Manage
            </Button>
          ) : (
            canRequest && (
              <LoginRedirect reason="perform-action">
                <Button
                  color="yellow"
                  fullWidth
                  disabled={full}
                  onClick={() =>
                    dialogStore.trigger({
                      component: ServiceRequestModal,
                      props: { offering, sellerUsername },
                    })
                  }
                >
                  Request
                </Button>
              </LoginRedirect>
            )
          )}
          {extra}
        </div>
      </div>
    </Paper>
  );
}
