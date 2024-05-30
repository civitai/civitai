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
  ({ iconOnly, children, tooltip, modelVersionId, ...buttonProps }, ref) => {
    const { isLoadingAccess, canDownload, earlyAccessConfig } = useModelVersionPermission({
      modelVersionId,
    });

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
        <Button
          pos="relative"
          ref={ref}
          disabled={isLoadingAccess}
          {...buttonProps}
          variant="light"
        >
          <IconDownload size={24} />
          {!isLoadingAccess && !canDownload && <>{purchaseIcon}</>}
        </Button>
      </Tooltip>
    ) : (
      <Button pos="relative" ref={ref} disabled={isLoadingAccess} {...buttonProps}>
        <Group spacing={8} noWrap>
          <IconDownload size={20} />
          {!canDownload && <>{purchaseIcon}</>}
          {children}
        </Group>
      </Button>
    );

    return canDownload ? button : <JoinPopover>{button}</JoinPopover>;
  }
);
_DownloadButton.displayName = 'DownloadButtonV2';

type Props = ButtonProps & {
  iconOnly?: boolean;
  modelVersionId?: number;
  tooltip?: string;
};

export const DownloadButtonV2 = createPolymorphicComponent<'button', Props>(_DownloadButton);
