import { ImageModel } from '../server/selectors/image.selector';
import { useMantineTheme } from '@mantine/core';
import { useCallback } from 'react';
import { useModalsContext } from '~/providers/CustomModalsProvider';
import { openContextModal } from '@mantine/modals';

type OpenLightboxProps = {
  initialSlide?: number;
  images?: ImageModel[];
};

export const useImageLightbox = ({ withRouter = true }: { withRouter?: boolean }) => {
  const theme = useMantineTheme();

  const { openModal } = useModalsContext();
  const fn = withRouter ? openModal : openContextModal;

  const openImageLightbox = useCallback(
    (innerProps: OpenLightboxProps) => {
      fn<OpenLightboxProps>({
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
    [fn, theme]
  );

  return { openImageLightbox };
};
