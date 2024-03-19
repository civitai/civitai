import {
  List,
  ThemeIcon,
  DefaultMantineColor,
  Stack,
  Divider,
  ThemeIconVariant,
  Text,
} from '@mantine/core';
import { IconAdCircleOff, IconCircleCheck, IconCircleX } from '@tabler/icons-react';

export const benefitIconSize = 18;
const themeIconSize = benefitIconSize + 6;

const defaultBenefits = [
  // { content: 'Ad free browsing', icon: <IconAdCircleOff size={benefitIconSize} /> },
  {
    content: (
      <Text variant="link" td="underline" component="a" href="/product/link" target="_blank">
        Civitai Link
      </Text>
    ),
  },
  // { content: 'Can equip special cosmetics' },
  { content: 'Exclusive Discord channels' },
  { content: 'Early access content' },
  { content: 'Early access to new features' },
];

export const PlanBenefitList = ({
  benefits,
  useDefaultBenefits = true,
  defaultBenefitsDisabled,
}: Props) => {
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
      {useDefaultBenefits && (
        <>
          <Divider mx="-md" />
          <List
            spacing="xs"
            size="md"
            center
            icon={
              <ThemeIcon
                color={defaultBenefitsDisabled ? 'gray' : 'green'}
                variant="light"
                size={themeIconSize}
                radius="xl"
              >
                {defaultBenefitsDisabled ? (
                  <IconCircleX size={benefitIconSize} />
                ) : (
                  <IconCircleCheck size={benefitIconSize} />
                )}
              </ThemeIcon>
            }
          >
            {defaultBenefits.map(({ content }, index) => (
              <List.Item key={index}>{content}</List.Item>
            ))}
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
};

export type BenefitItem = {
  content: React.ReactNode;
  icon?: React.ReactNode;
  iconColor?: DefaultMantineColor;
  iconVariant?: ThemeIconVariant;
};
