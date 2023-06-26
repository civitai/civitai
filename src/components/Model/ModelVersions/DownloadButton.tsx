import { Button, ButtonProps, Tooltip, createPolymorphicComponent } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { forwardRef } from 'react';
import { JoinPopover } from '~/components/JoinPopover/JoinPopover';

const _DownloadButton = forwardRef<HTMLButtonElement, Props>(
  ({ iconOnly, canDownload, ...buttonProps }, ref) => {
    const button = iconOnly ? (
      <Tooltip label="Download options" withArrow>
        <Button ref={ref} {...buttonProps} px={0} w={36} variant="light">
          <IconDownload size={16} />
        </Button>
      </Tooltip>
    ) : (
      <Button ref={ref} {...buttonProps} leftIcon={<IconDownload size={16} />} />
    );

    return canDownload ? button : <JoinPopover>{button}</JoinPopover>;
  }
);
_DownloadButton.displayName = 'DownloadButton';

type Props = ButtonProps & { iconOnly?: boolean; canDownload?: boolean };

export const DownloadButton = createPolymorphicComponent<'button', Props>(_DownloadButton);
