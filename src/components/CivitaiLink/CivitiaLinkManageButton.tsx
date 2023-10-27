import { Box, DefaultMantineColor, Loader, RingProgress } from '@mantine/core';
import { useHover } from '@mantine/hooks';
import { IconCheck, IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import {
  CivitaiLinkResourceManager,
  CivitaiLinkResourceManagerProps,
} from '~/components/CivitaiLink/CivitaiLinkResourceManager';
import { CivitaiTooltip, CivitaiTooltipProps } from '~/components/CivitaiWrapped/CivitaiTooltip';
import { useIsMobile } from '~/hooks/useIsMobile';

const buttonStates: Record<string, ButtonStateFn> = {
  downloading: ({ hovered, progress, iconSize }) => ({
    // icon: hovered ? <IconX strokeWidth={2.5} /> : <Loader color="#fff" size={24} />,
    icon: hovered ? (
      <IconX strokeWidth={2.5} size={iconSize} />
    ) : progress ? (
      <RingProgress
        size={iconSize ?? 30}
        thickness={4}
        rootColor="rgba(255, 255, 255, 0.4)"
        sections={[{ value: progress ?? 0, color: 'rgba(255, 255, 255, 0.8)' }]}
      />
    ) : (
      <Loader color="#fff" size={iconSize ?? 24} />
    ),
    color: hovered ? 'red' : 'blue',
    label: hovered ? 'Cancel download' : 'Downloading',
  }),
  installed: ({ hovered, iconSize }) => ({
    icon: hovered ? <IconTrash size={iconSize} /> : <IconCheck size={iconSize} strokeWidth={2.5} />,
    color: hovered ? 'red' : 'green',
    label: hovered ? 'Remove from SD' : 'Installed',
  }),
  notInstalled: ({ iconSize }) => ({
    icon: <IconPlus strokeWidth={2.5} size={iconSize} />,
    color: 'blue',
    label: 'Add to SD',
  }),
};

type ButtonStateFn = (props: { hovered: boolean; progress?: number; iconSize?: number }) => {
  icon: JSX.Element;
  color: DefaultMantineColor;
  label: string;
};

export const CivitiaLinkManageButton = ({
  children,
  noTooltip,
  tooltipProps = {},
  iconSize,
  ...managerProps
}: {
  iconSize?: number;
  children: (props: ChildFuncProps) => JSX.Element;
  noTooltip?: boolean;
  tooltipProps?: Omit<CivitaiTooltipProps, 'children' | 'label'>;
} & CivitaiLinkResourceManagerProps) => {
  const { hovered, ref } = useHover<HTMLButtonElement>();
  const isMobile = useIsMobile();

  return (
    <CivitaiLinkResourceManager {...managerProps}>
      {({ addResource, removeResource, cancelDownload, downloading, hasResource, progress }) => {
        const state = downloading ? 'downloading' : hasResource ? 'installed' : 'notInstalled';
        const buttonState = buttonStates[state]({
          hovered: !isMobile && hovered,
          progress,
          iconSize,
        });
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
