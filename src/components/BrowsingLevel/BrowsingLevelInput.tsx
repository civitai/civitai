import { NSFWLevel } from '@civitai/client';
import type { InputWrapperProps } from '@mantine/core';
import { Chip, Group, GroupProps, Input, createStyles } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { useCallback, useState } from 'react';
import { useBrowsingSettings, useToggleBrowsingLevel } from '~/providers/BrowserSettingsProvider';
import { NsfwLevel } from '~/server/common/enums';
import type { BrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { browsingLevels, browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';

type BrowsingLevelInput = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: number;
  onChange?: (value: number) => void;
};

export function BrowsingLevelsInput({ value, onChange, ...props }: BrowsingLevelInput) {
  const [browsingLevel, setBrowsingLevel] = useState<number>(value || 0);
  const onToggle = useCallback(
    (level: number) => {
      setBrowsingLevel((current) => Flags.toggleFlag(current, level));
    },
    [setBrowsingLevel]
  );

  useDidUpdate(() => {
    if (browsingLevel) {
      onChange?.(browsingLevel);
    }
  }, [browsingLevel]);

  useDidUpdate(() => {
    if (!isEqual(value, browsingLevel)) {
      // Value changed outside.
      setBrowsingLevel(value || 0);
    }
  }, [value]);

  return (
    <Input.Wrapper {...props} error={props.error}>
      <Group spacing="xs" mt="md" noWrap>
        {browsingLevels.map((level) => (
          <BrowsingLevelLabel
            key={level}
            level={level}
            browsingLevel={browsingLevel}
            onToggle={onToggle}
          />
        ))}
      </Group>
    </Input.Wrapper>
  );
}

function BrowsingLevelLabel({
  level,
  browsingLevel,
  onToggle,
}: {
  level: BrowsingLevel;
  browsingLevel: number;
  onToggle: (value: number) => void;
}) {
  const isSelected = Flags.hasFlag(browsingLevel, level);
  const { classes } = useStyles();

  // const browsingLevel = useStore((x) => x.browsingLevel);

  return (
    <Chip
      classNames={classes}
      checked={isSelected}
      onChange={() => onToggle(level)}
      variant={'outline'}
    >
      {/* Turns out, that when people are using google translate that string literals should be wrapped in a span to avoid errors  */}
      {/* https://github.com/remarkjs/react-markdown/pull/365 - at least this appears to have fixed the issue */}
      <span>{browsingLevelLabels[level]}</span>
    </Chip>
  );
}

const useStyles = createStyles((theme, _params, getRef) => ({
  root: {
    flex: 1,
  },
  label: {
    width: '100%',
    display: 'inline-flex',
    justifyContent: 'center',
    '&[data-checked]': {
      '&, &:hover': {
        backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
        color: theme.white,
      },

      [`& .${getRef('iconWrapper')}`]: {
        color: theme.white,
        display: 'none',

        [`@media (min-width: ${theme.breakpoints.xs}px)`]: {
          display: 'inline-block',
        },
      },
    },
    paddingLeft: 10,
    paddingRight: 10,
    [`@media (min-width: ${theme.breakpoints.xs}px)`]: {
      '&': {
        paddingLeft: 20,
        paddingRight: 20,
      },
    },
  },

  iconWrapper: {
    ref: getRef('iconWrapper'),
  },
}));
