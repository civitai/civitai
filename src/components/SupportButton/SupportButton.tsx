import { Button, ButtonProps, createStyles, HoverCard, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconCaretRightFilled, IconChevronRight, IconHeart } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { wiggle } from '~/libs/animations';
import { constants } from '~/server/common/constants';
import { getRandom } from '~/utils/array-helpers';

export const SupportButton = ({ className, ...props }: Props) => {
  const { classes, cx, theme } = useStyles();
  const [button, setButton] = useState<React.ReactNode>(null);

  useEffect(() => {
    setButton(
      getRandom([
        <Button
          key={0}
          component={NextLink}
          variant="light"
          color="gray"
          href="/pricing?utm_campaign=badge"
          compact
          className={cx(classes.root, className)}
          px={4}
          py={2}
          h={36}
          {...props}
        >
          <EdgeMedia src={constants.supporterBadge} width={24} />
          <IconChevronRight size={18} strokeWidth={2.5} />
        </Button>,
        <Button
          key={1}
          component={NextLink}
          variant="outline"
          color="green"
          href="/pricing?utm_campaign=doit"
          compact
          className={cx(classes.root, className)}
          pr={2}
          py={2}
          h={36}
          {...props}
        >
          <Text weight={500}>Do It</Text>
          <IconChevronRight size={18} strokeWidth={2.5} />
        </Button>,
        <Button
          key={2}
          component={NextLink}
          variant="light"
          color="green"
          href="/pricing?utm_campaign=emoji_money"
          compact
          className={cx(classes.root, className)}
          px={4}
          py={2}
          h={36}
          {...props}
        >
          <Text size={24}>💸</Text>
          <IconChevronRight size={18} strokeWidth={2.5} />
        </Button>,
        <Button
          key={3}
          component={NextLink}
          variant="light"
          color="green"
          href="/pricing?utm_campaign=emoji_kiss"
          compact
          className={cx(classes.root, className)}
          px={4}
          py={2}
          h={36}
          {...props}
        >
          <Text size={24}>😘</Text>
          <IconChevronRight size={18} strokeWidth={2.5} />
        </Button>,
        <Button
          key={4}
          component={NextLink}
          variant="light"
          color="red"
          href="/pricing?utm_campaign=icon_heart"
          compact
          className={cx(classes.root, className)}
          px={4}
          py={2}
          h={36}
          {...props}
        >
          <IconHeart color={theme.colors.red[4]} strokeWidth={2.5} />
          <IconChevronRight size={18} strokeWidth={2.5} />
        </Button>,
      ])
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!button) return null;

  return (
    <HoverCard withArrow openDelay={500}>
      <HoverCard.Target>{button}</HoverCard.Target>
      <HoverCard.Dropdown>
        <Text>You should really press this button.</Text>
        <Text>{`There's stuff here you wanna see...`}</Text>
        <Text>Do it! Click it! Really!</Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
};

type Props = {
  size?: 'sm' | 'md' | 'lg' | 'xl';
} & ButtonProps;

const useStyles = createStyles((theme) => ({
  root: {
    height: 30,
    cursor: 'pointer',
    position: 'relative',
    zIndex: 3,
  },
  svg: {
    height: 32,
    transform: 'translateZ(0)',
    // animation: `${pulseSize} 1s ease-in-out infinite`,

    [`&:hover`]: {
      animation: `${wiggle()} 750ms ease-in-out infinite`,
    },
    [theme.fn.largerThan('sm')]: {
      height: 24,
      marginRight: 4,
    },
  },

  heart: {
    stroke: '#ff6666',
    strokeWidth: 2.5,
    transformOrigin: 'center',
    transform: 'scale(1)',
  },

  pulser: {
    transformOrigin: 'center',
    transform: 'scale(1) translateZ(0)',
    // animation: `${pulse} 1s ease-in-out infinite`,
  },
}));
