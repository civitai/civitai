import type { SegmentedControlItem, SegmentedControlProps } from '@mantine/core';
import {
  Anchor,
  Group,
  SegmentedControl,
  Text,
  ThemeIcon,
  createStyles,
  Badge,
  Loader,
} from '@mantine/core';
import type { IconProps } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import React from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const useStyles = createStyles((theme, _, getRef) => ({
  label: {
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 6,
    paddingRight: 10,
  },
  container: {
    position: 'relative',
    '&:hover': {
      [`& .${getRef('scrollArea')}`]: {
        '&::-webkit-scrollbar': {
          opacity: 1,
        },
        '&::-webkit-scrollbar-thumb': {
          backgroundColor:
            theme.colorScheme === 'dark'
              ? theme.fn.rgba(theme.white, 0.5)
              : theme.fn.rgba(theme.black, 0.5),
        },
      },
    },
  },
  root: {
    ref: getRef('scrollArea'),
    overflow: 'auto',
    scrollSnapType: 'x mandatory',
    '&::-webkit-scrollbar': {
      background: 'transparent',
      opacity: 0,
      height: 8,
    },
    '&::-webkit-scrollbar-thumb': {
      borderRadius: 4,
    },
    backgroundColor: 'transparent',
    gap: 8,
    maxWidth: '100%',
  },
  control: { border: 'none !important' },
}));

export function HomeStyleSegmentedControl({
  data,
  value: activePath,
  onChange,
  size,
  sx,
  loading,
  ...props
}: Props) {
  const { classes, theme } = useStyles();
  const { canViewNsfw } = useFeatureFlags();

  const options: SegmentedControlItem[] = Object.entries(data).map(([key, value]) => ({
    label: (
      <Link legacyBehavior href={value.url} passHref>
        <Anchor variant="text">
          <Group align="center" spacing={8} noWrap>
            <ThemeIcon
              size={30}
              color={activePath === key ? theme.colors.dark[7] : 'transparent'}
              p={6}
            >
              {value.icon({
                color:
                  theme.colorScheme === 'dark' || activePath === key
                    ? theme.white
                    : theme.colors.dark[7],
              })}
            </ThemeIcon>
            <Text size="sm" transform="capitalize" inline>
              {value.label ?? key}
            </Text>
            {/* Ideally this is a temporary solution. We should be using the `canViewNsfw` feature flag to return the correct numbers to the users */}
            {canViewNsfw && value.count != null && (
              <Badge>
                {loading ? <Loader size="xs" variant="dots" /> : value.count.toLocaleString()}
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
        sx={(theme) => ({
          ...(typeof sx === 'function' ? sx(theme) : sx),
        })}
        size="md"
        classNames={classes}
        value={activePath}
        data={options.filter((item) => item.disabled === undefined || item.disabled === false)}
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
