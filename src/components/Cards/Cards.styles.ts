import { createStyles } from '@mantine/core';

export const useCardStyles = createStyles<string, { aspectRatio: number }>(
  (theme, params, getRef) => {
    const imageRef = getRef('image');
    const { aspectRatio } = params;

    return {
      root: {
        position: 'relative',
        overflow: 'hidden',
        color: 'white',
        '&:hover': {
          [`& .${imageRef}`]: {
            transform: 'scale(1.05)',
          },
        },
      },

      image: {
        ref: imageRef,
        height: '100%',
        objectFit: 'cover',
        objectPosition: aspectRatio < 1 ? 'top-center' : 'center',
        transition: 'transform 400ms ease',
        minWidth: '100%',
      },

      noImage: {
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[3],
        position: 'relative',

        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          left: 0,
          height: '100%',
          width: '100%',
          background: 'linear-gradient(transparent, rgba(0,0,0,.6))',
        },
      },

      gradientOverlay: {
        background: 'linear-gradient(transparent, rgba(0,0,0,.6))',
      },

      fullOverlay: {
        display: 'flex',
        justifyContent: 'end',
        background: 'linear-gradient(transparent, rgba(0,0,0,.6))',
      },

      contentOverlay: {
        position: 'absolute',
        width: '100%',
        left: 0,
        zIndex: 10,
        padding: theme.spacing.sm,
      },

      top: { top: 0 },
      bottom: { bottom: 0 },

      iconBadge: { color: 'white', backgroundColor: theme.fn.rgba('#000', 0.31) },

      infoChip: {
        borderRadius: theme.radius.sm,
        backgroundColor: theme.fn.rgba('#000', 0.31),
      },

      chip: {
        borderRadius: theme.radius.xl,
        height: '26px',
      },

      noHover: {
        '&:hover': {
          [`& .${imageRef}`]: {
            transform: 'initial',
          },
        },
      },

      imageGroupContainer: {
        display: 'flex',
        flexWrap: 'wrap',
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',

        '& > img, & > canvas': {
          width: '50%',
          height: '50%',
          flexGrow: 1,
          minWidth: '50%',
          minHeight: '50%',
        },
      },
    };
  }
);
