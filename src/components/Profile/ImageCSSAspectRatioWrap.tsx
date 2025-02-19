import { createStyles } from '@mantine/core';
import { CSSProperties } from 'react';

const useStyles = createStyles((theme, { aspectRatio = 1 }: { aspectRatio: number }) => ({
  actions: {
    height: '100%',
    width: '100%',
  },
  wrap: {
    overflow: 'hidden',
    borderRadius: theme.radius.md,
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cover: {
    position: 'relative',
    width: '100%',
    overflow: 'hidden',
    height: 0,
    paddingBottom: `${(aspectRatio * 100).toFixed(3)}%`,

    '& > div': {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    },

    '& img': {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
    },
  },
}));

export const ImageCSSAspectRatioWrap = ({
  children,
  aspectRatio,
  style,
  className,
}: {
  style?: CSSProperties;
  children: React.ReactNode;
  aspectRatio: number;
  className?: string;
}) => {
  const { classes, cx } = useStyles({ aspectRatio });
  return (
    <div className={cx(classes.wrap, className)} style={style}>
      <div className={classes.cover}>
        <div className="size-full">{children}</div>
      </div>
    </div>
  );
};
