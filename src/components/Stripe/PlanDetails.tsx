import { Stack, Title, Text, Center, createStyles } from '@mantine/core';
import { IconCirclePlus, IconClock } from '@tabler/icons';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { benefitIconSize, BenefitItem, PlanBenefitList } from '~/components/Stripe/PlanBenefitList';

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
            <EdgeImage src={image} width={128} className={classes.image} />
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
      {
        content: (
          <Text>
            Early access to{' '}
            <Text
              component="a"
              variant="link"
              href="https://sharing.clickup.com/8459928/b/h/6-900500453357-2/56d60e52b842e83"
              target="_blank"
            >
              new features
            </Text>
          </Text>
        ),
      },
      { content: 'Unique Supporter Tier badge' },
      { content: 'Unique nameplate color' },
      {
        content: 'More coming soon!',
        icon: <IconCirclePlus size={benefitIconSize} />,
        iconColor: 'blue',
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
    [theme.fn.smallerThan('sm')]: {
      width: 96,
      marginBottom: theme.spacing.xs,
    },
  },
  title: {
    [theme.fn.smallerThan('sm')]: {
      fontSize: 20,
    },
  },
  price: {
    [theme.fn.smallerThan('sm')]: {
      fontSize: 16,
    },
  },
}));
