import { createStyles } from '@mantine/core';
import { constants } from '~/server/common/constants';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';

export const useCardStyles = createStyles<string, { aspectRatio: number }>(
  (theme, params, getRef) => {
    const imageRef = getRef('image');
    const headerRef = getRef('header');
    const topRef = getRef('top');
    const bottomRef = getRef('bottom');
    const { aspectRatio } = params;
    const framePadding = constants.cosmetics.frame.padding;

    return {
      root: {
        height: '100%',
        color: 'white',
        '&:hover': {
          [`& .${imageRef}`]: {
            transform: 'scale(1.05)',
          },
          '& :after': {
            transform: 'scale(1.05)',
            opacity: 0,
          },
        },
      },

      frameAdjustment: {
        height: '100%',

        '&:after': {
          content: '""',
          position: 'absolute',
          pointerEvents: 'none',
          top: framePadding,
          left: framePadding,
          right: framePadding,
          bottom: framePadding,
          borderRadius: theme.radius.md - 2,
          boxShadow: 'inset 0 1px 2px 1px rgba(255,255,255, 0.3), 0 1px 2px rgba(0, 0, 0, 0.4)',
          zIndex: 1000,
          transition: 'transform 400ms ease, opacity 400ms ease',
        },
        [`& .${imageRef}`]: {
          padding: framePadding,
          borderRadius: 8 + framePadding,
          height: '100%',
          width: '100%',
          objectFit: 'cover',
          zIndex: 2,
        },
      },

      image: {
        ref: imageRef,
        height: '100%',
        objectFit: 'cover',
        objectPosition: aspectRatio < 1 ? 'top center' : 'center',
        transition: 'transform 400ms ease',
        minWidth: '100%',
      },

      header: {
        ref: headerRef,
        padding: '12px',
        background: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[2],
        width: '100%',
      },

      blurHash: {
        opacity: 1,
      },

      content: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 2,
        opacity: 0,
        transition: theme.other.fadeIn,
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

      top: { top: 0, ref: topRef },
      bottom: { bottom: 0, ref: bottomRef },

      iconBadge: { color: 'white', backgroundColor: theme.fn.rgba('#000', 0.31) },

      infoChip: {
        borderRadius: theme.radius.sm,
        backgroundColor: theme.fn.rgba('#000', 0.31),
        color: theme.white,
        [`.mantine-Badge-inner`]: {
          display: 'flex',
          overflow: 'visible',
        },
        [`.mantine-Divider-root`]: {
          margin: `-4px 8px`,
          borderLeftColor: theme.fn.rgba('#fff', 0.31),
          borderRightColor: theme.fn.rgba('#000', 0.2),
          borderRightWidth: 1,
          borderRightStyle: 'solid',
        },
      },

      reactions: {
        borderRadius: theme.radius.sm,
        backgroundColor: theme.fn.rgba('#000', 0.31),
        boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
        height: 28,
        paddingRight: 3,
      },

      statChip: {
        borderRadius: theme.radius.sm,
        backgroundColor: theme.fn.rgba('#000', 0.31),
        alignSelf: 'flex-start',
        [`.mantine-Badge-inner`]: {
          display: 'flex',
          overflow: 'visible',
          gap: theme.spacing.xs,
        },
        color: theme.white,
        [`&[data-reviewed=true]`]: {
          backgroundColor: theme.fn.rgba(theme.colors.success[5], 0.2),
        },
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
          height: 'auto',
          flexGrow: 1,
          minWidth: '50%',
          minHeight: '50%',
        },
      },

      imageGroupContainer4x4: {
        '& > img, & > canvas': {
          height: '50%',
        },
      },

      link: {
        [`&:has(~ .frame-decor) .${bottomRef}`]: {
          paddingBottom: '36px !important',
        },
      },

      dropShadow: {
        filter: 'drop-shadow(1px 1px 1px rgba(0, 0, 0, 0.8))',
      },
    };
  }
);

export const useFrameStyles = createStyles<
  string,
  { frame?: string; texture?: ContentDecorationCosmetic['data']['texture'] }
>((theme, params) => {
  const { frame, texture } = params;
  const frameBackground = [texture?.url, frame].filter(Boolean).join(', ');
  const framePadding = constants.cosmetics.frame.padding;

  return {
    root: {
      padding: '0 !important',
      color: 'white',
      borderRadius: theme.radius.md,
      cursor: 'pointer',
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: params.frame ? 'transparent' : undefined,
      margin: params.frame ? -framePadding : undefined,
    },

    frame: {
      position: 'relative',
      backgroundImage: frameBackground,
      backgroundSize: texture?.size
        ? `${texture.size.width}px ${texture.size.height}px, cover`
        : undefined,
      borderRadius: theme.radius.md,
      zIndex: 2,
      padding: framePadding,
      boxShadow: 'inset 0 0 1px 1px rgba(255,255,255, 0.3), 0 1px 2px rgba(0, 0, 0, 0.8)',
    },

    glow: {
      position: 'relative',
      '&:before': {
        backgroundImage: params.frame,
        content: '""',
        width: '100%',
        height: '100%',
        filter: 'blur(5px)',
        position: 'absolute',
        top: 0,
        left: 0,
      },
    },
  };
});
