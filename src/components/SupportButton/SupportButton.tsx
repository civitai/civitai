import { Button, ButtonProps, Text, createStyles, HoverCard } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconArrowRight, IconCaretRightFilled, IconChevronRight } from '@tabler/icons-react';
import { PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import { planDetails } from '~/components/Stripe/PlanDetails';
import { wiggle } from '~/libs/animations';
export const SupportButton = ({ className, ...props }: Props) => {
  const { classes, cx } = useStyles();

  return (
    <HoverCard withArrow>
      <HoverCard.Target>
        <Button
          component={NextLink}
          variant="outline"
          color="green"
          href="/pricing"
          compact
          className={cx(classes.root, className)}
          pr={3}
          {...props}
        >
          <Text weight={500}>Do It</Text>
          <IconCaretRightFilled size={16} strokeWidth={2.5} />
        </Button>
      </HoverCard.Target>
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
