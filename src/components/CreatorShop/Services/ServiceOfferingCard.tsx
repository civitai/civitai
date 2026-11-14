import { Anchor, Group, Paper, Stack, Text } from '@mantine/core';
import { useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { serviceTermsLine } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceRatingBadge } from '~/components/CreatorShop/Services/ServiceRatingBadge';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import type { ProfileImage } from '~/server/selectors/image.selector';
import { Currency } from '~/shared/utils/prisma/enums';

// Owner and storefront rows select different extras; the card reads only these.
type ServiceCoverImage = Pick<
  ProfileImage,
  'id' | 'name' | 'url' | 'nsfwLevel' | 'hash' | 'userId' | 'type' | 'width' | 'height' | 'metadata'
>;

export function ServiceOfferingCard({
  offering,
  footer,
}: {
  offering: Pick<
    ServiceOffering,
    'title' | 'description' | 'price' | 'deliveryDays' | 'revisionsIncluded' | 'maxNsfwLevel'
  > & { coverImage?: ServiceCoverImage | null };
  footer?: ReactNode;
}) {
  const domain = useDomainColor();
  const cover = offering.coverImage;
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  // The card can mount wide and narrow afterwards (a profile row), so re-measure on resize.
  const descriptionRef = useResizeObserver<HTMLParagraphElement>((entry) => {
    const el = entry.target;
    if (!expanded) setClamped(el.scrollHeight > el.clientHeight);
  });
  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight);
  }, [offering.description, expanded, descriptionRef]);
  return (
    <Paper withBorder radius="md" p="md" className="flex h-full flex-col">
      {cover && (
        <div
          className="relative -mx-4 -mt-4 mb-3 overflow-hidden rounded-t-md bg-gray-2 dark:bg-dark-5"
          style={{ aspectRatio: '16 / 9' }}
        >
          <ImageGuard2 image={cover}>
            {(safe) =>
              safe ? (
                <EdgeMedia2
                  src={cover.url}
                  name={cover.name}
                  type={cover.type}
                  metadata={cover.metadata as MixedObject | null}
                  skip={getSkipValue({
                    type: cover.type,
                    metadata: cover.metadata as MixedObject | null,
                  })}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  wrapperProps={{ className: 'size-full' }}
                  width={450}
                />
              ) : (
                <MediaHash {...cover} />
              )
            }
          </ImageGuard2>
        </div>
      )}
      <Stack gap={6} className="flex-1">
        <Group justify="space-between" align="flex-start" gap="xs" wrap="nowrap">
          <Text fw={700} lineClamp={2}>
            {offering.title}
          </Text>
          <ServiceRatingBadge rating={offering.maxNsfwLevel} />
        </Group>
        <Text size="sm" c="dimmed">
          {serviceTermsLine(offering)}
        </Text>
        <Text
          ref={descriptionRef}
          size="sm"
          lineClamp={expanded ? undefined : 4}
          className="whitespace-pre-line"
        >
          {offering.description}
        </Text>
        {(clamped || expanded) && (
          <Anchor
            component="button"
            type="button"
            size="sm"
            className="self-start"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Show less' : 'Show more'}
          </Anchor>
        )}
        <Group justify="space-between" mt="auto" pt="xs" wrap="nowrap">
          <CurrencyBadge
            currency={Currency.BUZZ}
            type={domain === 'green' ? 'green' : 'yellow'}
            unitAmount={offering.price}
            variant="transparent"
            className="!px-0"
          />
        </Group>
      </Stack>
      {footer}
    </Paper>
  );
}
