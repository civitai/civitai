import { Stack, Title, Text, List, Center, ThemeIcon, DefaultMantineColor } from '@mantine/core';
import { IconCircleCheck, IconCirclePlus, IconClock } from '@tabler/icons';
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
  const { benefits, image } = meta.find((x) => x.name === name) ?? {};

  return (
    <Stack>
      <Stack spacing={0} mb="md">
        {image && (
          <Center>
            <EdgeImage src={image} width={128} />
          </Center>
        )}
        <Title order={2} align="center">
          {name}
        </Title>
        <Text align="center" color="dimmed">
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
