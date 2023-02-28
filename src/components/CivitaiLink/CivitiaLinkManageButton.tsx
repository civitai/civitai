import { Box, DefaultMantineColor, Loader, Text } from '@mantine/core';
import { useHover } from '@mantine/hooks';
import { IconCheck, IconPlus, IconTrash, IconX } from '@tabler/icons';
import {
  CivitaiLinkResourceManager,
  CivitaiLinkResourceManagerProps,
} from '~/components/CivitaiLink/CivitaiLinkResourceManager';
import { CivitaiTooltip, CivitaiTooltipProps } from '~/components/CivitaiWrapped/CivitaiTooltip';

const buttonStates: Record<string, ButtonStateFn> = {
  downloading: (hovered) => ({
    icon: hovered ? <IconX strokeWidth={2.5} /> : <Loader color="#fff" size={24} />,
    color: hovered ? 'red' : 'blue',
    label: hovered ? 'Cancel download' : 'Downloading',
  }),
  installed: (hovered) => ({
    icon: hovered ? <IconTrash /> : <IconCheck strokeWidth={2.5} />,
    color: hovered ? 'red' : 'green',
    label: hovered ? 'Remove from SD' : 'Installed',
  }),
  notInstalled: () => ({
    icon: <IconPlus strokeWidth={2.5} />,
    color: 'blue',
    label: 'Add to SD',
  }),
};

type ButtonStateFn = (hovered: boolean) => {
  icon: JSX.Element;
  color: DefaultMantineColor;
  label: string;
};

export const CivitiaLinkManageButton = ({
  children,
  noTooltip,
  tooltipProps = {},
  ...managerProps
}: {
  children: (props: ChildFuncProps) => JSX.Element;
  noTooltip?: boolean;
  tooltipProps?: Omit<CivitaiTooltipProps, 'children' | 'label'>;
} & CivitaiLinkResourceManagerProps) => {
  const { hovered, ref } = useHover<HTMLButtonElement>();

  return (
    <CivitaiLinkResourceManager {...managerProps}>
      {({ addResource, removeResource, cancelDownload, downloading, hasResource }) => {
        const state = downloading ? 'downloading' : hasResource ? 'installed' : 'notInstalled';
        const buttonState = buttonStates[state](hovered);
        const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();

          if (downloading) cancelDownload();
          else if (hasResource) removeResource();
          else addResource();
        };

        if (noTooltip) return children({ ref, onClick, ...buttonState });

        return (
          <CivitaiTooltip label={buttonState.label} {...tooltipProps}>
            <Box>{children({ ref, onClick, ...buttonState })}</Box>
          </CivitaiTooltip>
        );
      }}
    </CivitaiLinkResourceManager>
  );
};

type ChildFuncProps = {
  ref: React.RefObject<HTMLButtonElement>;
  color: DefaultMantineColor;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  icon: React.ReactNode;
  label: string;
};
