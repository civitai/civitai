import { Stack, Title, Text, List } from '@mantine/core';

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
  const { benefits } = meta.find((x) => x.name === name) ?? {};

  return (
    <Stack>
      <Stack spacing={0}>
        <Title order={2} align="center">
          {name}
        </Title>
        <Text align="center">
          ${unitAmount / 100} {currency.toUpperCase()} / {interval}
        </Text>
      </Stack>
      {benefits && (
        <List>
          {benefits.map((benefit, index) => (
            <List.Item key={index}>{benefit}</List.Item>
          ))}
        </List>
      )}
      {description && <Text>{description}</Text>}
    </Stack>
  );
}

const meta = [
  {
    name: 'Supporter Tier',
    benefits: [
      'Limited time supporter option',
      'Manage your Automatic1111 Stable Diffusion instance right from Civitai',
      'Unique supporter tier badge, plus new badges each month',
      'Unique name color for flexing',
      'More coming soon!',
    ],
  },
];
