import { useMantineTheme } from '@mantine/core';
import { openContextModal } from '@mantine/modals';
import { ImageSimpleModel } from '~/server/validators/image/selectors';
import { useCallback } from 'react';

type OpenLightboxProps = {
  initialSlide?: number;
  images?: ImageSimpleModel[];
};

export const useImageLightbox = () => {
  const theme = useMantineTheme();

  const openImageLightbox = useCallback(
    ({ initialSlide, images }: OpenLightboxProps) => {
      openContextModal({
        modal: 'imageLightbox',
        fullScreen: true,
        withCloseButton: false,
        styles: {
          modal: {
            background: theme.colors.dark[7],
          },
        },
        innerProps: {
          initialSlide,
          images,
        },
      });
    },
    [theme]
  );

  return { openImageLightbox };
};
