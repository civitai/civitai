import {
  Button,
  ButtonProps,
  Center,
  List,
  Paper,
  Stack,
  Text,
  Title,
  createStyles,
  Group,
} from '@mantine/core';
import {
  IconArrowRight,
  IconBarbell,
  IconBarcode,
  IconBrush,
  IconCoin,
  IconCoins,
  IconHighlight,
  IconMoneybag,
  IconShoppingBag,
  IconShoppingCart,
  IconUsers,
} from '@tabler/icons-react';
import React from 'react';
import { MouseEvent } from 'react';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { RedeemCodeModal } from '~/components/RedeemableCode/RedeemCodeModal';
import { generationPanel } from '~/store/generation.store';

const useStyles = createStyles((theme) => ({
  featureCard: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
  },
}));

const getEarnings = (): (FeatureCardProps & { key: string })[] => [
  // {
  //   key: 'referrals',
  //   icon: <IconUsers size={32} />,
  //   title: 'Referrals',
  //   description: 'You & your friends can earn more Buzz!',
  //   btnProps: {
  //     href: '/user/account#referrals',
  //     children: 'Invite a friend',
  //   },
  // },
  {
    key: 'bounties',
    icon: <IconMoneybag size={32} />,
    title: 'Bounties',
    description: 'Submit work to a bounty to win Buzz',
    btnProps: {
      href: '/bounties',
      children: 'Learn more',
    },
  },
  {
    key: 'purchase',
    icon: <IconCoin size={32} />,
    title: 'Purchase',
    description: 'Purchase Buzz directly',
    btnProps: {
      href: '/purchase/buzz',
      children: 'Buy now',
    },
  },
  {
    key: 'tips',
    icon: <IconCoins size={32} />,
    title: 'Get tipped',
    description: 'Create awesome content!',
    btnProps: {
      href: '/posts/create',
      children: 'Create post',
    },
  },
  {
    key: 'redeem',
    icon: <IconBarcode size={32} />,
    title: 'Redeem a code',
    description: 'Purchased a Buzz card? Redeem it to get your Buzz!',
    btnProps: {
      onClick: () => {
        dialogStore.trigger({ component: RedeemCodeModal });
      },
      children: 'Redeem code',
    },
  },
];

export const EarningBuzz = ({ asList, withCTA }: Props) => {
  const earnings = getEarnings();

  return (
    <Stack spacing={20}>
      <Stack spacing={4}>
        <Group spacing="xs" align="center">
          <Title order={2}>Earn Buzz</Title>
          <Button
            compact
            size="xs"
            mt={4}
            onClick={() => {
              dialogStore.trigger({ component: RedeemCodeModal });
            }}
            variant="outline"
          >
            Redeem Code
          </Button>
        </Group>
        <Text>Need some Buzz? Here&rsquo;s how you can earn it</Text>
      </Stack>
      {asList ? (
        <FeatureList data={earnings} />
      ) : (
        <ContainerGrid gutter={20}>
          {earnings.map((item) => (
            <ContainerGrid.Col key={item.key} xs={12} sm={4} md={3}>
              <FeatureCard {...item} withCTA={withCTA ?? item.withCTA} />
            </ContainerGrid.Col>
          ))}
        </ContainerGrid>
      )}
    </Stack>
  );
};

const getSpendings = ({
  username,
  balance,
}: {
  username: string;
  balance: number;
}): (FeatureCardProps & { key: string })[] => [
  {
    key: 'train',
    icon: <IconBarbell size={32} />,
    title: 'Train',
    description: 'Train your own LoRAs to generate images',
    btnProps: {
      href: '/models/train',
      children: 'Train now',
      rightIcon: <IconArrowRight size={14} />,
    },
  },
  {
    key: 'generate',
    icon: <IconBrush size={32} />,
    title: 'Generate Images',
    description: 'Create using thousands of community resources.',
    btnProps: {
      component: 'button',
      onClick: (e: MouseEvent<HTMLElement>) => {
        e.preventDefault();
        generationPanel.open();
      },
      children: 'Generate now',
      rightIcon: <IconArrowRight size={14} />,
    },
  },
  {
    key: 'tip',
    icon: <IconCoins size={32} />,
    title: 'Tip an artist',
    description: 'Support an artist you love!',
    btnProps: {
      href: '/images',
      children: 'View artists',
      rightIcon: <IconArrowRight size={14} />,
    },
  },
  {
    key: 'bounties',
    icon: <IconMoneybag size={32} />,
    title: 'Bounties',
    description: 'Post a bounty and award Buzz',
    btnProps: {
      href: '/bounties/create',
      children: 'Post a bounty',
      rightIcon: <IconArrowRight size={14} />,
    },
  },
  {
    key: 'showcase',
    icon: <IconHighlight size={32} />,
    title: 'Get showcased',
    description: 'Boost your model to our homepage',
    btnProps: {
      target: '_blank',
      rel: 'noreferrer nofollow',
      href: `https://forms.clickup.com/8459928/f/825mr-8431/V3OV7JWR6SQFUYT7ON?Civitai%20Username=${encodeURIComponent(
        username ?? ''
      )}&Buzz%20Available=${balance ?? 0}`,
      children: 'Contact us',
      rightIcon: <IconArrowRight size={14} />,
    },
  },
  {
    key: 'badges',
    icon: <IconShoppingBag size={32} />,
    title: 'Shop badges and cosmetics',
    description: 'Make your profile stand out!',
    btnProps: {
      href: '/shop',
      children: 'Get some!',
      rightIcon: <IconArrowRight size={14} />,
    },
  },
  {
    key: 'merch',
    icon: <IconShoppingCart size={32} />,
    title: 'Shop merch',
    description: 'Tons of fun stickers to choose from...',
    btnProps: {
      disabled: true,
      children: 'COMING SOON',
    },
  },
];

export const SpendingBuzz = ({ asList, withCTA }: Props) => {
  const currentUser = useCurrentUser();
  const { balance } = useBuzz();
  // const open = useGenerationStore((state) => state.open);
  const spendings = getSpendings({
    username: currentUser?.username ?? '',
    balance: balance ?? 0,
  });

  return (
    <Stack spacing={20}>
      <Stack spacing={4}>
        <Title order={2}>Spend Buzz</Title>
        <Text>Got some Buzz? Here&rsquo;s what you can do with it</Text>
      </Stack>
      {asList ? (
        <FeatureList data={spendings} />
      ) : (
        <ContainerGrid gutter={20}>
          {spendings.map((item) => (
            <ContainerGrid.Col key={item.key} xs={12} sm={4} md={3}>
              <FeatureCard {...item} withCTA={withCTA ?? item.withCTA} />
            </ContainerGrid.Col>
          ))}
        </ContainerGrid>
      )}
    </Stack>
  );
};

type Props = { asList?: boolean; withCTA?: boolean };

type FeatureCardProps = {
  title: string;
  description: string;
  icon: React.ReactNode;
  btnProps: ButtonProps & {
    href?: string;
    component?: 'a' | 'button';
    target?: string;
    rel?: string;
    onClick?: (e: MouseEvent<HTMLElement>) => void;
  };
  withCTA?: boolean;
};

export const FeatureCard = ({ title, description, icon, btnProps, withCTA }: FeatureCardProps) => {
  const { classes } = useStyles();

  if (!withCTA && btnProps.disabled) return null;

  return (
    <Paper withBorder className={classes.featureCard} h="100%">
      <Stack spacing={4} p="md" align="center" h="100%">
        <Center>{icon}</Center>
        <Text weight={500} size="xl" align="center" transform="capitalize">
          {title}
        </Text>
        <Text color="dimmed" align="center">
          {description}
        </Text>
        {withCTA && <Button component="a" mt="auto" w="100%" {...btnProps} />}
      </Stack>
    </Paper>
  );
};

export const FeatureList = ({ data }: { data: FeatureCardProps[] }) => {
  return (
    <List
      listStyleType="none"
      spacing={8}
      icon={<CurrencyIcon currency="BUZZ" size={20} style={{ verticalAlign: 'middle' }} />}
    >
      {data.map((item, index) => (
        <List.Item key={index}>
          <Stack spacing={0}>
            <Text weight={590} transform="capitalize">
              {item.title}
              {item.btnProps.disabled ? ' (Coming Soon)' : ''}
            </Text>
            <Text color="dimmed">{item.description}</Text>
          </Stack>
        </List.Item>
      ))}
    </List>
  );
};
