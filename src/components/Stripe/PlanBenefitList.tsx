import { List, ThemeIcon, DefaultMantineColor } from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons';

export const benefitIconSize = 18;
const themeIconSize = benefitIconSize + 6;

export const PlanBenefitList = ({ benefits }: Props) => {
  return (
    <List
      spacing="xs"
      size="md"
      center
      icon={
        <ThemeIcon color="teal" size={themeIconSize} radius="xl">
          <IconCircleCheck size={benefitIconSize} />
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
  );
};

type Props = {
  benefits: BenefitItem[];
};

export type BenefitItem = {
  content: React.ReactNode;
  icon?: React.ReactNode;
  iconColor?: DefaultMantineColor;
};
