import type { ButtonProps } from '@mantine/core';
import { Button, Group, Tooltip, createPolymorphicComponent } from '@mantine/core';
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
};

export const DownloadButton = createPolymorphicComponent<'button', Props>(_DownloadButton);
