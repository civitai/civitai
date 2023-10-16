import {
  Button,
  ButtonProps,
  Center,
  Grid,
  List,
  Paper,
  Stack,
  Text,
  Title,
  createStyles,
} from '@mantine/core';
import {
  IconArrowRight,
  IconBarbell,
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
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const useStyles = createStyles((theme) => ({
  featureCard: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
  },
}));

const getEarnings = (): (FeatureCardProps & { key: string })[] => [
  {
    key: 'referrals',
    icon: <IconUsers size={32} />,
    title: 'Referrals',
    description: 'You & your friends can earn more buzz!',
    btnProps: {
      href: '/user/account#referrals',
      children: 'Invite a friend',
    },
  },
  {
    key: 'bounties',
    icon: <IconMoneybag size={32} />,
    title: 'Bounties',
    description: 'Submit work to a bounty to win buzz',
    btnProps: {
      href: '/bounties',
      children: 'Learn more',
    },
  },
  {
    key: 'purchase',
    icon: <IconCoin size={32} />,
    title: 'Purchase',
    description: 'Purchase buzz directly',
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
];

export const EarningBuzz = ({ asList, withCTA }: Props) => {
  const earnings = getEarnings();

  return (
    <Stack spacing={20}>
      <Stack spacing={4}>
        <Title order={2}>Earning Buzz</Title>
        <Text>Need some buzz? Here&rsquo;s how you can earn it</Text>
      </Stack>
      {asList ? (
        <FeatureList data={earnings} />
      ) : (
        <Grid gutter={20}>
          {earnings.map((item) => (
            <Grid.Col key={item.key} xs={12} md={3}>
              <FeatureCard {...item} withCTA={withCTA ?? item.withCTA} />
            </Grid.Col>
          ))}
        </Grid>
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
  // {
  //   key: 'generate',
  //   icon: <IconBrush size={32} />,
  //   title: 'Generate Images',
  //   description: 'Use any of our models to create',
  //   btnProps: {
  //     component: 'button',
  //     onClick: (e: MouseEvent<HTMLElement>) => {
  //       e.preventDefault();
  //       open();
  //     },
  //     children: 'Generate now',
  //     rightIcon: <IconArrowRight size={14} />,
  //   },
  // },
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
    description: 'Post a bounty and award buzz',
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
    key: 'merch',
    icon: <IconShoppingCart size={32} />,
    title: 'Shop merch',
    description: 'Tons of fun stickers to choose from...',
    btnProps: {
      disabled: true,
      children: 'COMING SOON',
    },
  },
  {
    key: 'badges',
    icon: <IconShoppingBag size={32} />,
    title: 'Shop badges and cosmetics',
    description: 'Make your profile stand out!',
    btnProps: {
      disabled: true,
      children: 'COMING SOON',
    },
  },
];

export const SpendingBuzz = ({ asList, withCTA }: Props) => {
  const currentUser = useCurrentUser();
  // const open = useGenerationStore((state) => state.open);
  const spendings = getSpendings({
    username: currentUser?.username ?? '',
    balance: currentUser?.balance ?? 0,
  });

  return (
    <Stack spacing={20}>
      <Stack spacing={4}>
        <Title order={2}>Spending Buzz</Title>
        <Text>Got some buzz? Here&rsquo;s what you can do with it</Text>
      </Stack>
      {asList ? (
        <FeatureList data={spendings} />
      ) : (
        <Grid gutter={20}>
          {spendings.map((item) => (
            <Grid.Col key={item.key} xs={12} md={3}>
              <FeatureCard {...item} withCTA={withCTA ?? item.withCTA} />
            </Grid.Col>
          ))}
        </Grid>
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
        <Text weight={500} size="xl" align="center">
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
            <Text weight={590}>
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
