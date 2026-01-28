import type { InputWrapperProps } from '@mantine/core';
import { Badge, Card, Checkbox, Group, Input, Stack, Text, Tooltip } from '@mantine/core';
import { NsfwLevel } from '~/server/common/enums';
import {
  browsingLevelLabels,
  browsingLevelDescriptions,
  flagifyBrowsingLevel,
  parseBitwiseBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';

type Props = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: number;
  onChange?: (value: number) => void;
};

// Levels that can be selected (excluding Blocked)
const selectableLevels = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
] as const;

// Color mapping for each level
const levelColors: Record<number, string> = {
  [NsfwLevel.PG]: 'green',
  [NsfwLevel.PG13]: 'yellow',
  [NsfwLevel.R]: 'orange',
  [NsfwLevel.X]: 'red',
  [NsfwLevel.XXX]: 'grape',
};

// Preset options for quick selection
const presets = [
  { label: 'SFW Only', value: flagifyBrowsingLevel([NsfwLevel.PG, NsfwLevel.PG13]) },
  {
    label: 'Include Mature',
    value: flagifyBrowsingLevel([NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R]),
  },
  { label: 'All Content', value: flagifyBrowsingLevel([...selectableLevels]) },
];

/**
 * Content rating selector for challenges.
 * Allows selecting which NSFW levels are allowed for entries.
 * Compatible with withController HOC for form integration.
 */
export function ContentRatingSelect({ value = 1, onChange, ...inputWrapperProps }: Props) {
  const selectedLevels = parseBitwiseBrowsingLevel(value);

  const handleLevelToggle = (level: (typeof selectableLevels)[number], checked: boolean) => {
    let newLevels = [...selectedLevels];

    if (checked) {
      // Add this level and all lower levels (if adding PG-13, also include PG)
      const levelIndex = selectableLevels.indexOf(level);
      for (let i = 0; i <= levelIndex; i++) {
        if (!newLevels.includes(selectableLevels[i])) {
          newLevels.push(selectableLevels[i]);
        }
      }
    } else {
      // Remove this level and all higher levels
      const levelIndex = selectableLevels.indexOf(level);
      newLevels = newLevels.filter((l) => {
        const idx = (selectableLevels as readonly number[]).indexOf(l);
        return idx !== -1 && idx < levelIndex;
      });
    }

    // Ensure at least PG is always selected
    if (!newLevels.includes(NsfwLevel.PG)) {
      newLevels.push(NsfwLevel.PG);
    }

    onChange?.(flagifyBrowsingLevel(newLevels));
  };

  const handlePreset = (presetValue: number) => {
    onChange?.(presetValue);
  };

  return (
    <Input.Wrapper
      label="Allowed Content Ratings"
      description="Select which content ratings are allowed for challenge entries"
      {...inputWrapperProps}
    >
      <Stack gap="xs" mt={5}>
        {/* Quick presets */}
        <Group gap="xs">
          {presets.map((preset) => (
            <Badge
              key={preset.label}
              variant={value === preset.value ? 'filled' : 'light'}
              color={value === preset.value ? 'blue' : 'gray'}
              style={{ cursor: 'pointer' }}
              onClick={() => handlePreset(preset.value)}
            >
              {preset.label}
            </Badge>
          ))}
        </Group>

        {/* Individual level selection */}
        <Card withBorder p="sm">
          <Stack gap="xs">
            {selectableLevels.map((level) => {
              const isChecked = selectedLevels.includes(level);
              const label = browsingLevelLabels[level];
              const description = browsingLevelDescriptions[level];
              const color = levelColors[level];

              return (
                <Group key={level} justify="space-between" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap">
                    <Checkbox
                      checked={isChecked}
                      onChange={(e) => handleLevelToggle(level, e.currentTarget.checked)}
                      disabled={level === NsfwLevel.PG} // PG is always required
                    />
                    <Badge color={color} variant="light" size="sm" w={55}>
                      {label}
                    </Badge>
                    <Tooltip label={description} multiline w={300}>
                      <Text size="sm" c="dimmed" style={{ cursor: 'help' }} lineClamp={1}>
                        {description}
                      </Text>
                    </Tooltip>
                  </Group>
                </Group>
              );
            })}
          </Stack>
        </Card>

        {/* Summary */}
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            Allowed:
          </Text>
          {selectableLevels
            .filter((level) => selectedLevels.includes(level))
            .map((level) => (
              <Badge key={level} size="xs" color={levelColors[level]} variant="filled">
                {browsingLevelLabels[level]}
              </Badge>
            ))}
        </Group>
      </Stack>
    </Input.Wrapper>
  );
}
