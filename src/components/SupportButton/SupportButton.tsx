import type { ButtonProps, UnstyledButtonProps, FloatingPosition } from '@mantine/core';
import {
  Button,
  HoverCard,
  Text,
  Group,
  Stack,
  Badge,
  createPolymorphicComponent,
  UnstyledButton
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { IconProps, Icon } from '@tabler/icons-react';
import {
  IconSparkles,
  IconHeart,
  IconGift,
  IconRocket,
  IconBolt,
  IconStar,
  IconTrophy,
  IconCrown,
  IconDiamond,
} from '@tabler/icons-react';
import { useAppContext } from '~/providers/AppProvider';
import { Random } from '~/utils/random';
import { isHolidaysTime } from '~/utils/date-helpers';
import classes from './SupportButton.module.scss';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import React, { forwardRef } from 'react';
import clsx from 'clsx';

type Variant = 'primary' | 'gift' | 'heart' | 'sparkle' | 'royal' | 'premium';
type SupportButtonOption = {
  text: string;
  icon: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
  variant: Variant;
  href: string;
};

const options: SupportButtonOption[] = [
  {
    text: 'Pro',
    icon: IconDiamond,
    variant: 'royal',
    href: '/pricing?utm_campaign=support_pro',
  },
  // {
  //   text: 'Upgrade',
  //   icon: IconRocket,
  //   variant: 'primary',
  //   href: '/pricing?utm_campaign=support_upgrade',
  // },
  // {
  //   text: 'Premium',
  //   icon: IconDiamond,
  //   variant: 'premium',
  //   href: '/pricing?utm_campaign=support_premium',
  // },
  // {
  //   text: 'Elite',
  //   icon: IconTrophy,
  //   variant: 'sparkle',
  //   href: '/pricing?utm_campaign=support_elite',
  // },
  // {
  //   text: 'VIP',
  //   icon: IconBolt,
  //   variant: 'sparkle',
  //   href: '/pricing?utm_campaign=support_vip',
  // },
  // {
  //   text: 'Perks',
  //   icon: IconStar,
  //   variant: 'heart',
  //   href: '/pricing?utm_campaign=support_perks',
  // },
];

const holidayButton: SupportButtonOption = {
  text: 'Holiday',
  icon: IconGift,
  variant: 'gift',
  href: '/pricing?utm_campaign=holiday_promo',
};

export const SupportButton = () => {
  const { seed } = useAppContext();
  const selectedOption = new Random(seed).fromArray(options);

  return (
    <HoverCard withArrow openDelay={400} closeDelay={100}>
      <HoverCard.Target>
        <SupportButtonPolymorphic
          component={Link}
          href={selectedOption.href}
          className={`${classes.supportButtonMediaQuery}`}
          classVariant={selectedOption.variant}
          variant="filled"
          px="xs"
          icon={selectedOption.icon}
        >
          {selectedOption.text}
        </SupportButtonPolymorphic>
      </HoverCard.Target>
      <HoverCard.Dropdown className={classes.supportHoverCard}>
        <Stack gap="xs">
          <Group gap="xs">
            <IconSparkles size={18} color="var(--mantine-color-yellow-6)" />
            <Text fw={600} size="sm" c="yellow.6">
              Unlock Premium Benefits!
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            Join thousands of creators with exclusive perks, priority support, and advanced
            features.
          </Text>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
};

interface SupportButtonBaseProps
  extends UnstyledButtonProps,
    Omit<React.ComponentPropsWithoutRef<'button'>, keyof UnstyledButtonProps> {
  icon?: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
  position?: FloatingPosition;
  classVariant?: Variant;
}

const SupportButtonBase = forwardRef<HTMLButtonElement, SupportButtonBaseProps>(
  ({ position, icon: Icon, children, className, classVariant = 'primary', ...props }, ref) => {
    const getVariantStyles = (variant: SupportButtonOption['variant']) => {
      switch (variant) {
        case 'primary':
          return classes.supportButtonPrimary;
        case 'gift':
          return classes.supportButtonGift;
        case 'heart':
          return classes.supportButtonHeart;
        case 'sparkle':
          return classes.supportButtonSparkle;
        case 'royal':
          return classes.supportButtonRoyal;
        case 'premium':
          return classes.supportButtonPremium;
        default:
          return classes.supportButtonPrimary;
      }
    };

    return (
      <HoverCard withArrow openDelay={400} closeDelay={100} position={position} withinPortal>
        <HoverCard.Target>
          <UnstyledButton
            ref={ref}
            className={clsx(
              `${classes.supportButton} ${getVariantStyles(classVariant)}`,
              className
            )}
            {...props}
          >
            {children && (
              <Text component="span" size="xs" fw={700} className={classes.supportButtonText}>
                {children}
              </Text>
            )}
            {Icon && <Icon size={16} className={classes.supportButtonIcon} />}
          </UnstyledButton>
        </HoverCard.Target>
        <HoverCard.Dropdown className={classes.supportHoverCard}>
          <Stack gap="xs">
            <Group gap="xs">
              <IconSparkles size={18} color="var(--mantine-color-yellow-6)" />
              <Text fw={600} size="sm" c="yellow.6">
                Unlock Premium Benefits!
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              Join thousands of creators with exclusive perks, priority support, and advanced
              features.
            </Text>
          </Stack>
        </HoverCard.Dropdown>
      </HoverCard>
    );
  }
);
SupportButtonBase.displayName = 'SupportButtonBase';
export const SupportButtonPolymorphic = createPolymorphicComponent<
  'button',
  SupportButtonBaseProps
>(SupportButtonBase);
