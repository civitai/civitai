import type { ButtonProps } from '@mantine/core';
import { Button, Group, createPolymorphicComponent } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconDownload } from '@tabler/icons-react';
import { forwardRef } from 'react';
import { JoinPopover } from '~/components/JoinPopover/JoinPopover';
import { PaidAccessPriceBadge } from '~/components/Model/ModelVersions/PaidAccessPriceBadge';

const _DownloadButton = forwardRef<HTMLButtonElement, Props>(
  (
    {
      iconOnly,
      canDownload,
      downloadPrice,
      listedPrice,
      acceptsBlueBuzz,
      children,
      tooltip,
      joinAlert,
      unavailableReason,
      ...buttonProps
    },
    ref
  ) => {
    // `downloadPrice` is what THIS viewer must pay; `listedPrice` is what buyers pay, shown to the
    // owner who already has access and would otherwise see no price at all on their own model.
    const shownPrice = downloadPrice ?? listedPrice;
    const isListedOnly = downloadPrice == null && listedPrice != null;
    const purchaseIcon = (
      <PaidAccessPriceBadge
        price={shownPrice ?? 0}
        acceptsBlueBuzz={acceptsBlueBuzz}
        listedOnly={isListedOnly}
      />
    );

    const button = iconOnly ? (
      <Tooltip label={tooltip ?? 'Download options'} withArrow>
        <Button
          pos="relative"
          className="overflow-visible"
          ref={ref}
          {...buttonProps}
          variant="light"
        >
          <IconDownload size={24} />
          {!!shownPrice && <>{purchaseIcon}</>}
        </Button>
      </Tooltip>
    ) : (
      <Button pos="relative" className="overflow-visible" ref={ref} {...buttonProps}>
        <Group gap={8} wrap="nowrap">
          <IconDownload size={20} />
          {!!shownPrice && <>{purchaseIcon}</>}
          {children}
        </Group>
      </Button>
    );

    // A disabled button swallows hover and tap; the span keeps the reason tooltip reachable.
    if (unavailableReason)
      return (
        <Tooltip
          label={unavailableReason}
          withArrow
          multiline
          maw={280}
          events={{ hover: true, focus: true, touch: true }}
        >
          <span
            className={buttonProps.fullWidth ? 'block' : 'inline-block'}
            tabIndex={0}
            data-testid="download-unavailable"
          >
            {button}
          </span>
        </Tooltip>
      );

    return canDownload || (downloadPrice ?? 0) > 0 ? (
      button
    ) : (
      <JoinPopover message={joinAlert ?? 'You need to be a member to start the download'}>
        {button}
      </JoinPopover>
    );
  }
);
_DownloadButton.displayName = 'DownloadButton';

type Props = ButtonProps & {
  iconOnly?: boolean;
  canDownload?: boolean;
  downloadPrice?: number;
  /** What buyers pay. Informational only — shown to the owner/mod, never gates the button. */
  listedPrice?: number;
  /** The paid-access terms accept Blue Buzz — colours the price chip to say so. */
  acceptsBlueBuzz?: boolean;
  modelVersionId?: number;
  tooltip?: string;
  joinAlert?: string;
  /** Set when no purchase or membership can unlock the download: shown instead of the join prompt. */
  unavailableReason?: string;
};

export const DownloadButton = createPolymorphicComponent<'button', Props>(_DownloadButton);
