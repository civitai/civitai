import { Stack, Title, Text, List, Center, ThemeIcon, DefaultMantineColor } from '@mantine/core';
import { IconCircleCheck, IconCirclePlus, IconClock } from '@tabler/icons';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';

type SubscriptionCardProps = {
  name: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
  description: string | null;
};

const iconSize = 18;
const themeIconSize = iconSize + 6;

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
      <Stack spacing={0} mb="md">
        <Center>
          <EdgeImage src="c056e4d3-5161-433f-0201-31847be0dc00" width={128} />
        </Center>
        <Title order={2} align="center">
          {name}
        </Title>
        <Text align="center" color="dimmed">
          ${unitAmount / 100} {currency.toUpperCase()} / {interval}
        </Text>
      </Stack>
      {benefits && (
        <List
          spacing="xs"
          size="md"
          center
          icon={
            <ThemeIcon color="teal" size={themeIconSize} radius="xl">
              <IconCircleCheck size={iconSize} />
            </ThemeIcon>
          }
        >
          {benefits.map(({ content, icon, iconColor }, index) => (
            <List.Item
              key={index}
              icon={
                !icon ? undefined : (
                  <ThemeIcon color={iconColor ?? 'teal'} size={themeIconSize} radius="xl">
                    {icon}
                  </ThemeIcon>
                )
              }
            >
              {content}
            </List.Item>
          ))}
        </List>
      )}
      {description && <Text>{description}</Text>}
    </Stack>
  );
}

type BenefitItem = {
  content: React.ReactNode;
  icon?: React.ReactNode;
  iconColor?: DefaultMantineColor;
};

const meta: PlanMeta[] = [
  {
    name: 'Supporter Tier',
    benefits: [
      {
        content: 'Limited time supporter option',
        icon: <IconClock size={iconSize} />,
        iconColor: 'yellow',
      },
      { content: 'Early access to new features' },
      { content: 'Unique Supporter Tier badge' },
      { content: 'Unique nameplate color' },
      { content: 'More coming soon!', icon: <IconCirclePlus size={iconSize} />, iconColor: 'blue' },
    ],
  },
];

type PlanMeta = {
  name: string;
  benefits: BenefitItem[];
};
