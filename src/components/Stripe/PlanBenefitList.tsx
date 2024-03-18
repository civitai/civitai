import {
  List,
  ThemeIcon,
  DefaultMantineColor,
  ThemeIconProps,
  Stack,
  Divider,
} from '@mantine/core';
import { IconAdCircleOff, IconCircleCheck } from '@tabler/icons-react';

export const benefitIconSize = 18;
const themeIconSize = benefitIconSize + 6;

export const PlanBenefitList = ({ benefits }: Props) => {
  const defaultBenefits = [
    { content: 'Ad free browsing', icon: <IconAdCircleOff size={benefitIconSize} /> },
    { content: 'Civitai Link' },
    { content: 'Civitai Archive' },
    { content: 'Unique Supporter Badge each month' },
    { content: 'Can equip special cosmetics' },
    { content: 'Exclusive Discord channels' },
    { content: 'Early access content' },
    { content: 'Early access to new features' },
  ];

  return (
    <Stack>
      <List
        spacing="xs"
        size="md"
        center
        icon={
          <ThemeIcon color="gray" size={themeIconSize} radius="xl">
            <IconCircleCheck size={benefitIconSize} />
          </ThemeIcon>
        }
      >
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
      </List>
      <Divider mx="-md" />
      <List
        spacing="xs"
        size="md"
        center
        icon={
          <ThemeIcon color="gray" size={themeIconSize} radius="xl">
            <IconCircleCheck size={benefitIconSize} />
          </ThemeIcon>
        }
      >
        {defaultBenefits.map(({ content }, index) => (
          <List.Item key={index}>{content}</List.Item>
        ))}
      </List>
    </Stack>
  );
};

type Props = {
  benefits: BenefitItem[];
};

export type BenefitItem = {
  content: React.ReactNode;
  icon?: React.ReactNode;
  iconColor?: DefaultMantineColor;
  iconVariant?: ThemeIconProps['variant'];
};
