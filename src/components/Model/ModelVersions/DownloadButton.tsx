import {
  Button,
  ButtonProps,
  Tooltip,
  createPolymorphicComponent,
  useMantineTheme,
  ThemeIcon,
} from '@mantine/core';
import { IconBolt, IconDownload } from '@tabler/icons-react';
import { forwardRef } from 'react';
import { JoinPopover } from '~/components/JoinPopover/JoinPopover';

const _DownloadButton = forwardRef<HTMLButtonElement, Props>(
  ({ iconOnly, canDownload, downloadRequiresPurchase, children, tooltip, ...buttonProps }, ref) => {
    const purchaseIcon = (
      <ThemeIcon
        radius="xl"
        size="sm"
        color="yellow.7"
        style={{
          position: 'absolute',
          top: '-8px',
          right: '-8px',
        }}
      >
        <IconBolt size={16} />
      </ThemeIcon>
    );
    const button = iconOnly ? (
      <Tooltip label={tooltip ?? 'Download options'} withArrow>
        <Button pos="relative" ref={ref} {...buttonProps} px={0} w={36} variant="light">
          <IconDownload size={24} />
          {downloadRequiresPurchase && <>{purchaseIcon}</>}
        </Button>
      </Tooltip>
    ) : (
      <Button pos="relative" ref={ref} {...buttonProps} leftIcon={<IconDownload size={20} />}>
        {downloadRequiresPurchase && <>{purchaseIcon}</>}
        {children}
      </Button>
    );

    return canDownload || downloadRequiresPurchase ? button : <JoinPopover>{button}</JoinPopover>;
  }
);
_DownloadButton.displayName = 'DownloadButton';

type Props = ButtonProps & {
  iconOnly?: boolean;
  canDownload?: boolean;
  downloadRequiresPurchase?: boolean;
  modelVersionId?: number;
  tooltip?: string;
};

export const DownloadButton = createPolymorphicComponent<'button', Props>(_DownloadButton);
