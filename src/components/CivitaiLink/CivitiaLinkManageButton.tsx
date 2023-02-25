import { ActionIcon, Box, DefaultMantineColor, Loader, Text } from '@mantine/core';
import { useHover } from '@mantine/hooks';
import { IconCheck, IconPlus, IconTrash, IconX } from '@tabler/icons';
import {
  CivitaiLinkResourceManager,
  CivitaiLinkResourceManagerProps,
} from '~/components/CivitaiLink/CivitaiLinkResourceManager';
import { CivitaiTooltip } from '~/components/CivitaiWrapped/CivitaiTooltip';

export const CivitiaLinkManageButton = ({
  children,
  ...managerProps
}: { children: (props: ChildFuncProps) => JSX.Element } & CivitaiLinkResourceManagerProps) => {
  const { hovered, ref } = useHover();

  return (
    <CivitaiLinkResourceManager {...managerProps}>
      {({ addResource, removeResource, cancelDownload, downloading, hasResource }) => {
        const color: DefaultMantineColor = hasResource ? (hovered ? 'red' : 'green') : 'blue';
        const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();

          if (downloading) cancelDownload();
          else if (hasResource) removeResource();
          else addResource();
        };
        const icon = hasResource ? (
          downloading ? (
            hovered ? (
              <IconX strokeWidth={2.5} />
            ) : (
              <Loader color="#fff" size={24} />
            )
          ) : hovered ? (
            <IconTrash />
          ) : (
            <IconCheck strokeWidth={2.5} />
          )
        ) : (
          <IconPlus strokeWidth={2.5} />
        );

        return (
          <CivitaiTooltip
            position="right"
            transition="slide-right"
            variant="smallRounded"
            label={
              <Text size="xs" weight={500}>
                {hasResource ? 'Remove from SD' : 'Add to SD'}
              </Text>
            }
          >
            <Box>{children({ ref, color, onClick, icon })}</Box>
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
};
