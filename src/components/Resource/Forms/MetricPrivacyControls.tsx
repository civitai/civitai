import { Alert, Badge, Group, Stack, Text } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import type { InheritedMetricState } from '~/components/Resource/Forms/metric-privacy-hints';
import { InputSelect } from '~/libs/form';
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

const INHERIT_LABEL: Record<InheritedMetricState['source'], string> = {
  account: 'Inherit from account',
  model: 'Inherit from model',
  owner: "Inherit from owner's account",
};

/**
 * Who is editing, relative to the owner whose Creator Program membership gates the feature at read
 * time. An owner without one gets the sentence and no controls; a moderator gets live controls,
 * since the stored choice takes effect once the owner qualifies.
 */
export type MetricPrivacyAccess = 'owner' | 'owner-inactive' | 'moderator';

/** Per-model or per-version metric privacy; the account default in Creator Controls is the primary control. */
export function MetricPrivacyControls({
  level,
  inherited,
  access,
}: {
  level: 'model' | 'version';
  inherited: Record<ModelMetricPrivacyKey, InheritedMetricState>;
  access: MetricPrivacyAccess;
}) {
  const { watch } = useFormContext();
  const choices = watch('meta.metricVisibility') as
    | Partial<Record<ModelMetricPrivacyKey, MetricVisibilityChoice>>
    | undefined;

  if (access === 'owner-inactive')
    return (
      <Alert color="yellow" data-testid={`metric-privacy-${level}`}>
        Metric privacy applies while you hold an active Creator Program membership. These stats are
        shown until then.
      </Alert>
    );

  return (
    <Stack gap="xs" data-testid={`metric-privacy-${level}`}>
      <Text size="xs" c="dimmed">
        {level === 'model'
          ? "What this model's page and cards show."
          : "What this version's details card shows."}{' '}
        {access === 'moderator'
          ? 'Applies while the owner holds an active Creator Program membership.'
          : 'You and moderators always see the real numbers.'}
      </Text>
      {modelMetricPrivacyKeys.map((key) => {
        const choice = choices?.[key] ?? 'inherit';
        const hidden = choice === 'inherit' ? inherited[key].hidden : choice === 'hide';
        return (
          <Group key={key} justify="space-between" gap="xs" wrap="nowrap">
            <Group gap="xs" wrap="nowrap">
              <Text size="sm">{METRIC_LABEL[key]}</Text>
              {hidden !== null && (
                <Badge
                  size="xs"
                  variant="light"
                  color={hidden ? 'red' : 'green'}
                  data-testid={`metric-privacy-effective-${key}`}
                >
                  {hidden ? 'hidden' : 'shown'}
                </Badge>
              )}
            </Group>
            <InputSelect
              name={`meta.metricVisibility.${key}`}
              size="xs"
              w={210}
              allowDeselect={false}
              data-testid={`metric-privacy-select-${key}`}
              data={[
                { value: 'inherit', label: INHERIT_LABEL[inherited[key].source] },
                { value: 'hide', label: `Hide for this ${level}` },
                { value: 'show', label: `Show for this ${level}` },
              ]}
            />
          </Group>
        );
      })}
    </Stack>
  );
}
