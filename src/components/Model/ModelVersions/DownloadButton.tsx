import {
  Button,
  ButtonProps,
  Tooltip,
  createPolymorphicComponent,
  useMantineTheme,
} from '@mantine/core';
import { IconBolt, IconDownload } from '@tabler/icons-react';
import { forwardRef } from 'react';
import { JoinPopover } from '~/components/JoinPopover/JoinPopover';

const _DownloadButton = forwardRef<HTMLButtonElement, Props>(
  ({ iconOnly, canDownload, downloadRequiresPurchase, ...buttonProps }, ref) => {
    const theme = useMantineTheme();
    const purchaseIcon = (
      <IconBolt
        size={20}
        style={{
          position: 'absolute',
          fill: theme.colors.yellow[7],
          color: theme.colors.yellow[7],
          top: '-8px',
          right: '-8px',
        }}
      />
    );
    const button = iconOnly ? (
      <Tooltip label="Download options" withArrow>
        <Button pos="relative" ref={ref} {...buttonProps} px={0} w={36} variant="light">
          <IconDownload size={24} />
          {downloadRequiresPurchase && <>{purchaseIcon}</>}
        </Button>
      </Tooltip>
    ) : (
      <Button pos="relative" ref={ref} {...buttonProps} leftIcon={<IconDownload size={20} />}>
        {downloadRequiresPurchase && <>{purchaseIcon}</>}
      </Button>
    );

    return canDownload ? button : <JoinPopover>{button}</JoinPopover>;
  }
);
_DownloadButton.displayName = 'DownloadButton';

type Props = ButtonProps & {
  iconOnly?: boolean;
  canDownload?: boolean;
  downloadRequiresPurchase?: boolean;
  modelVersionId?: number;
};

export const DownloadButton = createPolymorphicComponent<'button', Props>(_DownloadButton);
