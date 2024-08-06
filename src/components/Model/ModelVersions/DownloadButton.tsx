import {
  Button,
  ButtonProps,
  Group,
  ThemeIcon,
  Tooltip,
  createPolymorphicComponent,
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
        <Button pos="relative" ref={ref} {...buttonProps} variant="light">
          <IconDownload size={24} />
          {downloadRequiresPurchase && <>{purchaseIcon}</>}
        </Button>
      </Tooltip>
    ) : (
      <Button pos="relative" ref={ref} {...buttonProps}>
        <Group spacing={8} noWrap>
          <IconDownload size={20} />
          {downloadRequiresPurchase && <>{purchaseIcon}</>}
          {children}
        </Group>
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
