import { Badge, BadgeProps } from '@mantine/core';
import { useIsLive } from '~/hooks/useIsLive';
import classes from './LiveNow.module.scss';

export function LiveNowIndicator(props: Omit<BadgeProps, 'children'>) {
  const isLive = useIsLive();
  if (!isLive) return null;

  return (
    <Badge
      component="a"
      className={classes.liveNow}
      {...props}
      href="/twitch"
      target="_blank"
      variant="dot"
      color="red"
      size="sm"
      onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
        event.stopPropagation();
      }}
    >
      Live
      <span className="hide-mobile"> On Twitch</span>
    </Badge>
  );
}
