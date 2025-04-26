import { NSFWLevel } from '@civitai/client';
import { Chip, Group, GroupProps, Input, InputWrapperProps } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { useCallback, useState } from 'react';
import { useBrowsingSettings, useToggleBrowsingLevel } from '~/providers/BrowserSettingsProvider';
import { NsfwLevel } from '~/server/common/enums';
import {
  browsingLevels,
  browsingLevelLabels,
  BrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';
import styles from './BrowsingLevelInput.module.scss';

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

  return (
    <Chip
      classNames={styles}
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

