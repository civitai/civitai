import { Button, Collapse, Group, Input, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { useState } from 'react';
import { useFormContext } from 'react-hook-form';
import {
  describeInheritedMetric,
  type InheritedMetricState,
} from '~/components/Resource/Forms/metric-privacy-hints';
import { InputSegmentedControl } from '~/libs/form';
import {
  modelMetricPrivacyKeys,
  type MetricVisibilityChoice,
  type ModelMetricPrivacyKey,
} from '~/server/utils/model-metric-privacy';

const METRIC_LABEL: Record<ModelMetricPrivacyKey, string> = {
  buzz: 'Earned Buzz',
  downloads: 'Downloads',
  generations: 'Generations',
};

const CHOICES: { label: string; value: MetricVisibilityChoice }[] = [
  { label: 'Inherit', value: 'inherit' },
  { label: 'Hide', value: 'hide' },
  { label: 'Show', value: 'show' },
];

/**
 * Metric privacy for one model or version: what each stat inherits, and a collapsed per-metric
 * override (inherit / hide / show) bound to `meta.metricVisibility.<metric>`. The account default
 * in Creator Controls is the primary control; this is the exception to it.
 */
export function MetricPrivacyControls({
  level,
  inherited,
  disabled,
  note,
}: {
  level: 'model' | 'version';
  inherited: Record<ModelMetricPrivacyKey, InheritedMetricState>;
  disabled?: boolean;
  note?: React.ReactNode;
}) {
  const { watch } = useFormContext();
  const choices = watch('meta.metricVisibility') as
    | Partial<Record<ModelMetricPrivacyKey, MetricVisibilityChoice>>
    | undefined;
  const overrides = modelMetricPrivacyKeys.filter(
    (key) => choices?.[key] && choices[key] !== 'inherit'
  );
  const [open, setOpen] = useState(overrides.length > 0);

  return (
    <Stack gap="xs" data-testid={`metric-privacy-${level}`}>
      {note && (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}
      {modelMetricPrivacyKeys.map((key) => (
        <Group key={key} justify="space-between" gap="xs" wrap="nowrap">
          <Text size="sm">{METRIC_LABEL[key]}</Text>
          <Text size="xs" c="dimmed" data-testid={`metric-privacy-inherited-${key}`}>
            {choices?.[key] && choices[key] !== 'inherit'
              ? `${choices[key] === 'hide' ? 'Hidden' : 'Shown'}, overridden for this ${level}`
              : describeInheritedMetric(inherited[key])}
          </Text>
        </Group>
      ))}
      <Button
        variant="subtle"
        size="compact-sm"
        onClick={() => setOpen((value) => !value)}
        rightSection={open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        className="self-start"
        data-testid={`metric-privacy-override-toggle-${level}`}
      >
        Override for this {level}
        {overrides.length ? ` (${overrides.length})` : ''}
      </Button>
      <Collapse in={open}>
        <Stack gap="xs">
          {modelMetricPrivacyKeys.map((key) => (
            <Input.Wrapper key={key} label={METRIC_LABEL[key]}>
              <InputSegmentedControl
                name={`meta.metricVisibility.${key}`}
                data={CHOICES}
                size="xs"
                disabled={disabled}
                fullWidth
              />
            </Input.Wrapper>
          ))}
          {level === 'version' && (
            <Text size="xs" c="dimmed">
              Show reveals this version&apos;s own count even when the model hides it.
            </Text>
          )}
        </Stack>
      </Collapse>
    </Stack>
  );
}
