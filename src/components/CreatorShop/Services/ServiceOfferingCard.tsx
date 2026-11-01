import { Anchor, Group, Paper, Stack, Text } from '@mantine/core';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { serviceTermsLine } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceRatingBadge } from '~/components/CreatorShop/Services/ServiceRatingBadge';
import { useDomainColor } from '~/hooks/useDomainColor';
import { Currency } from '~/shared/utils/prisma/enums';

export function ServiceOfferingCard({
  offering,
  footer,
}: {
  offering: Pick<
    ServiceOffering,
    'title' | 'description' | 'price' | 'deliveryDays' | 'revisionsIncluded' | 'maxNsfwLevel'
  >;
  footer?: ReactNode;
}) {
  const domain = useDomainColor();
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight);
  }, [offering.description, expanded]);
  return (
    <Paper withBorder radius="md" p="md" className="flex h-full flex-col">
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
