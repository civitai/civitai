import type { InputWrapperProps } from '@mantine/core';
import { Chip, Group, Input } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { useCallback, useState } from 'react';
import type { BrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { browsingLevels, browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import classes from './BrowsingLevelInput.module.scss';

type BrowsingLevelInput = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: number;
  onChange?: (value: number) => void;
  /** The levels to offer. Defaults to all of them; a hub offers only what its owner allows. */
  levels?: readonly BrowsingLevel[];
  /**
   * Report clearing the last level as 0. Off by default, which means the collection
   * forced-level form this input was written for cannot UNSET a level once set —
   * that is a bug in that form, not a property it relies on. The default stays off
   * so fixing it stays a deliberate change to what that form saves; delete this prop
   * once it is fixed.
   */
  allowEmpty?: boolean;
  /**
   * Shrink the chips so all of them still fit one row. The default row is full-size
   * and overflows a 300px sidebar; wrapping instead leaves XXX alone on a second
   * line, reading as though it were singled out.
   */
  compact?: boolean;
};

export function BrowsingLevelsInput({
  value,
  onChange,
  levels = browsingLevels,
  allowEmpty,
  compact,
  ...props
}: BrowsingLevelInput) {
  const [browsingLevel, setBrowsingLevel] = useState<number>(value || 0);
  const onToggle = useCallback(
    (level: number) => {
      setBrowsingLevel((current) => Flags.toggleFlag(current, level));
    },
    [setBrowsingLevel]
  );

  useDidUpdate(() => {
    if (browsingLevel || allowEmpty) {
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
      <Group gap={compact ? 2 : 'xs'} mt={compact ? 4 : 'md'} wrap="nowrap">
        {levels.map((level) => (
          <BrowsingLevelLabel
            key={level}
            level={level}
            browsingLevel={browsingLevel}
            onToggle={onToggle}
            compact={compact}
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
  compact,
}: {
  level: BrowsingLevel;
  browsingLevel: number;
  onToggle: (value: number) => void;
  compact?: boolean;
}) {
  const isSelected = Flags.hasFlag(browsingLevel, level);
  // const browsingLevel = useStore((x) => x.browsingLevel);

  return (
    <Chip
      classNames={compact ? { ...classes, label: `${classes.label} ${classes.compact}` } : classes}
      checked={isSelected}
      size={compact ? 'xs' : undefined}
      onChange={() => onToggle(level)}
      variant={'outline'}
    >
      {/* Turns out, that when people are using google translate that string literals should be wrapped in a span to avoid errors  */}
      {/* https://github.com/remarkjs/react-markdown/pull/365 - at least this appears to have fixed the issue */}
      <span>{browsingLevelLabels[level]}</span>
    </Chip>
  );
}
