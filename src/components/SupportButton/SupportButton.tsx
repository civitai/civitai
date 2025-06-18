import type { ButtonProps } from '@mantine/core';
import { Button, HoverCard, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconChevronRight, IconChristmasBall, IconHeart } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useAppContext } from '~/providers/AppProvider';
import { constants } from '~/server/common/constants';
import { Random } from '~/utils/random';
import { isHolidaysTime } from '~/utils/date-helpers';

type SupportButtonOption = Partial<ButtonProps> & { href: string };
const options: SupportButtonOption[] = [
  {
    variant: 'outline',
    color: 'green',
    href: '/pricing?utm_campaign=doit',
    children: <EdgeMedia src={constants.supporterBadge} width={24} />,
  },
  {
    variant: 'outline',
    color: 'green',
    href: '/pricing?utm_campaign=doit',
    children: <Text fw={500}>Do It</Text>,
  },
  {
    variant: 'light',
    color: 'green',
    href: '/pricing?utm_campaign=emoji_money',
    children: <Text size="xl">💸</Text>,
  },
  {
    variant: 'light',
    color: 'green',
    href: '/pricing?utm_campaign=emoji_kiss',
    children: <Text size="xl">😘</Text>,
  },
  {
    variant: 'light',
    color: 'red',
    href: '/pricing?utm_campaign=icon_heart',
    children: <IconHeart color="red" strokeWidth={2.5} />,
  },
];

const holidayButton: Partial<ButtonProps> & { href: string } = {
  variant: 'light',
  color: 'green',
  href: '/pricing?utm_campaign=holiday_promo',
  children: <IconChristmasBall color="red" />,
};

// const random = getRandom(options);
export const SupportButton = () => {
  const { seed } = useAppContext();
  const { children, ...buttonProps } = isHolidaysTime()
    ? holidayButton
    : new Random(seed).fromArray(options);

  return (
    <HoverCard withArrow openDelay={500}>
      <HoverCard.Target>
        <Button component={Link} className="relative z-10 cursor-pointer px-2" {...buttonProps}>
          {children}
          <IconChevronRight size={18} strokeWidth={2.5} />
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
