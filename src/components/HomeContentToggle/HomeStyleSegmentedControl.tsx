import type { SegmentedControlItem, SegmentedControlProps } from '@mantine/core';
import {
  Anchor,
  Badge,
  Group,
  Loader,
  SegmentedControl,
  Text,
  ThemeIcon,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import type { IconProps } from '@tabler/icons-react';
import React from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import classes from './HomeStyleSegmentedControl.module.css';

export function HomeStyleSegmentedControl({
  data,
  value: activePath,
  onChange,
  size,
  loading,
  ...props
}: Props) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { canViewNsfw } = useFeatureFlags();

  const options: SegmentedControlItem[] = Object.entries(data).map(([key, value]) => ({
    label: (
      <Link legacyBehavior href={value.url} passHref>
        <Anchor td="none" variant="text">
          <Group align="center" gap={8} wrap="nowrap">
            <ThemeIcon
              size={30}
              color={activePath === key ? theme.colors.dark[7] : 'transparent'}
              p={6}
            >
              {value.icon({
                color:
                  colorScheme === 'dark' || activePath === key ? theme.white : theme.colors.dark[7],
              })}
            </ThemeIcon>
            <Text size="sm" tt="capitalize" className="text-black dark:text-white" inline>
              {value.label ?? key}
            </Text>
            {/* Ideally this is a temporary solution. We should be using the `canViewNsfw` feature flag to return the correct numbers to the users */}
            {canViewNsfw && value.count != null && (
              <Badge classNames={{ label: 'overflow-visible' }}>
                {loading ? <Loader size="xs" type="dots" /> : value.count.toLocaleString()}
              </Badge>
            )}
          </Group>
        </Anchor>
      </Link>
    ),
    value: key,
    disabled: value.disabled,
  }));

  return (
    <div className={classes.container}>
      <SegmentedControl
        {...props}
        size="md"
        classNames={classes}
        value={activePath}
        data={options.filter((item) => item.disabled === undefined || item.disabled === false)}
        withItemsBorders={false}
      />
    </div>
  );
}

export type DataItem = {
  url: string;
  icon: (props?: IconProps) => React.ReactNode;
  disabled?: boolean;
  count?: number;
  label?: string;
};
type Props = {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  value: string;
  onChange?: (item: DataItem) => void;
  loading?: boolean;
  data: Record<string, DataItem>;
} & Omit<SegmentedControlProps, 'data' | 'value' | 'onChange'>;
