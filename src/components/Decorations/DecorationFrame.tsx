import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { createStyles } from '@mantine/core';

const useStyles = createStyles<string, { offset?: string; crop?: string }>((_, params) => ({
  frame: {
    position: 'absolute',
    objectFit: 'none',
    zIndex: 11,
    pointerEvents: 'none',
    width: params.crop ? `calc(100% - ${params.crop})` : '100%',
    height: params.crop ? `calc(100% - ${params.crop})` : '100%',
  },

  topLeft: {
    top: params.offset ?? 0,
    left: params.offset ?? 0,
    objectPosition: 'top left',
  },

  topRight: {
    top: params.offset ?? 0,
    right: params.offset ?? 0,
    objectPosition: 'top right',
  },

  bottomRight: {
    bottom: params.offset ?? 0,
    right: params.offset ?? 0,
    objectPosition: 'bottom right',
  },

  bottomLeft: {
    bottom: params.offset ?? 0,
    left: params.offset ?? 0,
    objectPosition: 'bottom left',
  },
}));

export function DecorationFrame({ decoration }: Props) {
  const { classes, cx } = useStyles({ crop: decoration.data.crop, offset: decoration.data.offset });
  if (!decoration.data.url) return null;

  return (
    <>
      <EdgeMedia
        src={decoration.data.url}
        type="image"
        name="card decoration"
        className={cx(classes.frame, classes.topLeft)}
        width={decoration.data.animated ? 'original' : DEFAULT_EDGE_IMAGE_WIDTH}
        anim={decoration.data.animated}
      />
      <EdgeMedia
        src={decoration.data.url}
        type="image"
        name="card decoration"
        className={cx(classes.frame, classes.topRight)}
        width={decoration.data.animated ? 'original' : DEFAULT_EDGE_IMAGE_WIDTH}
        anim={decoration.data.animated}
      />
      <EdgeMedia
        src={decoration.data.url}
        type="image"
        name="card decoration"
        className={cx(classes.frame, classes.bottomRight)}
        width={decoration.data.animated ? 'original' : DEFAULT_EDGE_IMAGE_WIDTH}
        anim={decoration.data.animated}
      />
      <EdgeMedia
        src={decoration.data.url}
        type="image"
        name="card decoration"
        className={cx(classes.frame, classes.bottomLeft)}
        width={decoration.data.animated ? 'original' : DEFAULT_EDGE_IMAGE_WIDTH}
        anim={decoration.data.animated}
      />
    </>
  );
}

type Props = { decoration: ContentDecorationCosmetic };
