import {
  Anchor,
  DefaultMantineColor,
  Divider,
  List,
  Stack,
  Text,
  ThemeIcon,
  ThemeIconVariant,
} from '@mantine/core';
import { IconAdCircleOff, IconCircleCheck, IconCircleX } from '@tabler/icons-react';

export const benefitIconSize = 18;
const themeIconSize = benefitIconSize + 6;

const defaultBenefits = [
  { content: 'Ad free browsing', icon: <IconAdCircleOff size={benefitIconSize} /> },
  {
    content: (
      <Text variant="link" td="underline" component="a" href="/product/link" target="_blank">
        Civitai Link
      </Text>
    ),
  },
  // { content: 'Can equip special cosmetics' },
  { content: 'Exclusive Discord channels' },
  { content: 'Early access to new features' },
  {
    tiers: ['bronze', 'silver', 'gold'], // Not available in supporter / founder.
    content: (
      <Text>
        Access to the{' '}
        <Anchor variant="link" td="underline" component="a" href="/creator-program" target="_blank">
          Creator Program
        </Anchor>{' '}
        to get paid for earned Buzz
      </Text>
    ),
  },
  { content: 'Enhanced Model Creator controls', tiers: ['gold'] },
];

export const PlanBenefitList = ({
  benefits,
  useDefaultBenefits = true,
  defaultBenefitsDisabled,
  tier,
}: Props) => {
  return (
    <Stack>
      <List
        size="md"
        center
        icon={
          <ThemeIcon color="gray" size={themeIconSize} radius="xl">
            <IconCircleCheck size={benefitIconSize} />
          </ThemeIcon>
        }
      >
        <Stack gap="xs">
          {benefits.map(({ content, icon, iconColor, iconVariant }, index) => (
            <List.Item
              key={index}
              icon={
                !icon ? undefined : (
                  <ThemeIcon
                    color={iconColor ?? 'teal'}
                    size={themeIconSize}
                    radius="xl"
                    variant={iconVariant}
                  >
                    {icon}
                  </ThemeIcon>
                )
              }
            >
              {content}
            </List.Item>
          ))}
        </Stack>
      </List>
      {useDefaultBenefits && (
        <>
          <Divider mx="-md" />
          <List size="md" center>
            <Stack gap="xs">
              {defaultBenefits.map(({ content, tiers }, index) => {
                const isUnavailable =
                  defaultBenefitsDisabled || (tiers && (!tier || !tiers.includes(tier)));
                return (
                  <List.Item
                    icon={
                      <ThemeIcon
                        color={isUnavailable ? 'gray' : 'green'}
                        variant="light"
                        size={themeIconSize}
                        radius="xl"
                      >
                        {isUnavailable ? (
                          <IconCircleX size={benefitIconSize} />
                        ) : (
                          <IconCircleCheck size={benefitIconSize} />
                        )}
                      </ThemeIcon>
                    }
                    key={index}
                  >
                    {content}
                  </List.Item>
                );
              })}
            </Stack>
          </List>
        </>
      )}
    </Stack>
  );
};

type Props = {
  benefits: BenefitItem[];
  useDefaultBenefits?: boolean;
  defaultBenefitsDisabled?: boolean;
  tier?: string;
};

export type BenefitItem = {
  content: React.ReactNode;
  icon?: React.ReactNode;
  iconColor?: DefaultMantineColor;
  iconVariant?: ThemeIconVariant;
};
