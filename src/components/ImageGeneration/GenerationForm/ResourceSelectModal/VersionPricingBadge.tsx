import type { ModelVersionPricingSignal } from '@civitai/buzz';
import { Badge, Tooltip } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { versionIsPaidToGenerate } from '~/shared/search/model-pricing-filter';

/**
 * Download pricing is deliberately absent: a version can gate its download while leaving generation
 * open, and in the generator that is a free resource.
 */
export function VersionPricingBadge({
  pricing,
  size,
}: {
  pricing?: ModelVersionPricingSignal[];
  /** `sm` for the compact row's badge line; the default sits over the card image. */
  size?: 'sm';
}) {
  if (!versionIsPaidToGenerate(pricing)) return null;

  return (
    <Tooltip
      // Free trials are per-viewer and unknowable from a shared search document, so never say
      // purchase is required — only that it is sold.
      label="The creator charges for generating with this version."
      position="top"
      withArrow
      withinPortal
      multiline
      maw={250}
    >
      <Badge
        color="yellow"
        {...(size === 'sm'
          ? { variant: 'light', size: 'sm', leftSection: <IconBolt size={12} /> }
          : {
              variant: 'filled',
              h: 30,
              px: 8,
              className: 'flex items-center gap-1',
              leftSection: <IconBolt size={14} />,
            })}
      >
        Paid
      </Badge>
    </Tooltip>
  );
}
