import { Button, HoverCard, Text, Group, Stack, Badge } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
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

type SupportButtonOption = {
  text: string;
  icon: React.ElementType;
  variant: 'primary' | 'gift' | 'heart' | 'sparkle' | 'royal' | 'premium';
  href: string;
};

const options: SupportButtonOption[] = [
  {
    text: 'Pro',
    icon: IconCrown,
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
  const selectedOption = isHolidaysTime() ? holidayButton : new Random(seed).fromArray(options);

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
    <HoverCard withArrow openDelay={400} closeDelay={100}>
      <HoverCard.Target>
        <Button
          component={Link}
          href={selectedOption.href}
          className={`${classes.supportButton} ${getVariantStyles(selectedOption.variant)}`}
          variant="filled"
          size="xs"
          px="xs"
        >
          <Group gap={4} wrap="nowrap">
            <Text size="xs" fw={700} className={classes.supportButtonText}>
              {selectedOption.text}
            </Text>
            <selectedOption.icon size={16} className={classes.supportButtonIcon} />
          </Group>
        </Button>
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
