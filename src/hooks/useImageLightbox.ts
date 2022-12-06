import { ImageModel } from '../server/selectors/image.selector';
import { useMantineTheme } from '@mantine/core';
import { useCallback } from 'react';
import { useModalsContext } from '~/providers/CustomModalsProvider';

type OpenLightboxProps = {
  initialSlide?: number;
  images?: ImageModel[];
};

export const useImageLightbox = () => {
  const theme = useMantineTheme();

  const { openModal } = useModalsContext();

  const openImageLightbox = useCallback(
    (innerProps: OpenLightboxProps) => {
      openModal<OpenLightboxProps>({
        modal: 'imageLightbox',
        fullScreen: true,
        withCloseButton: false,
        styles: {
          modal: {
            background: theme.colors.dark[7],
          },
        },
        innerProps,
      });
    },
    [openModal, theme]
  );

  return { openImageLightbox };
};
