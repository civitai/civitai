import { Badge, BadgeProps } from '@mantine/core';
import { useIsLive } from '~/hooks/useIsLive';

export function LiveNowIndicator(props: Omit<BadgeProps, 'children'>) {
  const isLive = useIsLive();
  if (!isLive) return null;

  return (
    <Badge
      component="a"
      style={{ cursor: 'pointer' }}
      styles={{
        root: {
          '&:before': {
            animation: `blink 2s linear infinite`,
          },
        },
      }}
      {...props}
      href="/twitch"
      target="_blank"
      variant="dot"
      color="red"
      size="sm"
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      {`Live`}
      <span className="hide-mobile"> On Twitch</span>
    </Badge>
  );
}
 