import {
  Anchor,
  Group,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlProps,
  Text,
  ThemeIcon,
  createStyles,
  Badge,
} from '@mantine/core';
import { TablerIconsProps } from '@tabler/icons-react';
import Link from 'next/link';
import React from 'react';

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
  ...props
}: Props) {
  const { classes, theme } = useStyles();

  const options: SegmentedControlItem[] = Object.entries(data).map(([key, value]) => ({
    label: (
      <Link href={value.url} passHref>
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
            {value.count && <Badge>{value.count}</Badge>}
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
  icon: (props?: TablerIconsProps) => React.ReactNode;
  disabled?: boolean;
  count?: number | string;
  label?: string;
};
type Props = {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  value: string;
  onChange?: (item: DataItem) => void;
  data: Record<string, DataItem>;
} & Omit<SegmentedControlProps, 'data' | 'value' | 'onChange'>;
