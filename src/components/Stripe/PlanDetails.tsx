import { Stack, Title, Text, Center, createStyles } from '@mantine/core';
import { IconCirclePlus, IconClock } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { benefitIconSize, BenefitItem, PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import { CurrencyBadge } from '../Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { containerQuery } from '~/utils/mantine-css-helpers';

type SubscriptionCardProps = {
  name: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
  description: string | null;
};

export function PlanDetails({
  name,
  unitAmount,
  currency,
  interval,
  description,
}: SubscriptionCardProps) {
  const { classes } = useStyles();
  const { benefits, image } = meta.find((x) => x.name === name) ?? {};

  return (
    <Stack>
      <Stack spacing={0} mb="md">
        {image && (
          <Center>
            <EdgeMedia src={image} width={128} className={classes.image} />
          </Center>
        )}
        <Title className={classes.title} order={2} align="center">
          {name}
        </Title>
        <Text className={classes.price} align="center" color="dimmed">
          ${unitAmount / 100} per {interval}
        </Text>
      </Stack>
      {benefits && <PlanBenefitList benefits={benefits} />}
      {description && <Text>{description}</Text>}
    </Stack>
  );
}

const meta: PlanMeta[] = [
  {
    name: 'Supporter Tier',
    image: 'c056e4d3-5161-433f-0201-31847be0dc00',
    benefits: [
      {
        content: 'Limited time supporter option',
        icon: <IconClock size={benefitIconSize} />,
        iconColor: 'yellow',
      },
      { content: 'Early access to new features' },
      { content: 'Unique Supporter Tier badge' },
      { content: 'Unique nameplate color' },
      { content: 'Unique Discord role' },
      {
        content: (
          <Text>
            <Text span>
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={5000} /> each month
            </Text>
          </Text>
        ),
      },
    ],
  },
];

type PlanMeta = {
  name: string;
  image: string;
  benefits: BenefitItem[];
};

const useStyles = createStyles((theme) => ({
  image: {
    [containerQuery.smallerThan('sm')]: {
      width: 96,
      marginBottom: theme.spacing.xs,
    },
  },
  title: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: 20,
    },
  },
  price: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: 16,
    },
  },
}));
