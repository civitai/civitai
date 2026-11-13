import { Checkbox, Stack, Text } from '@mantine/core';
import { useResourceData } from '~/components/generation_v2/inputs/ResourceDataProvider';
import { ResourceSelectInput } from '~/components/generation_v2/inputs/ResourceSelectInput';
import type { ResourceData } from '~/shared/form-graph/generation/defs';
import {
  turboLoraToAdd,
  type ResourcesTurboMeta,
  type TurboLoraMeta,
} from '~/shared/form-graph/generation/turbo';
import type { GenerationResource } from '~/shared/types/generation.types';

/** An unusable pick (unpublished, private) stays the pick; the toggle adds the family's default until it is usable again. */
export function TurboRow({
  turbo,
  pick,
  familyDefaultId,
  options,
  onToggle,
  onChange,
}: {
  turbo: ResourcesTurboMeta;
  pick: ResourceData;
  familyDefaultId: number;
  options: TurboLoraMeta['options'];
  onToggle: (on: boolean, lora?: ResourceData) => void;
  onChange: (lora: ResourceData) => void;
}) {
  const { data: hydrated, isLoading } = useResourceData(pick.id);
  const needsFallback = !isLoading && (!hydrated || !hydrated.canGenerate);
  const { data: familyDefault } = useResourceData(
    needsFallback && familyDefaultId !== pick.id ? familyDefaultId : undefined
  );
  const toAdd = turboLoraToAdd({
    pick,
    hydrated,
    loading: isLoading,
    familyDefaultId,
    familyDefault,
  });
  const lora = 'lora' in toAdd ? toAdd.lora : undefined;
  const shown = turbo.active ?? pick;
  const description = turbo.full
    ? 'Remove a resource to make room for Turbo'
    : toAdd.status === 'unavailable'
    ? "This turbo LoRA isn't available right now"
    : 'Fewer steps for faster, cheaper images, at some cost to quality';
  return (
    <Stack gap={0} className="overflow-hidden rounded-md border border-gray-3 dark:border-dark-4">
      <Checkbox
        className="p-3"
        label="Turbo"
        description={description}
        checked={turbo.enabled}
        disabled={!turbo.enabled && (turbo.full || !lora)}
        onChange={(e) => (e.currentTarget.checked ? lora && onToggle(true, lora) : onToggle(false))}
      />
      {turbo.enabled && (
        <ResourceSelectInput
          flush
          value={shown as GenerationResource}
          onChange={(next) => next && onChange(next as ResourceData)}
          buttonLabel="Choose a turbo LoRA"
          modalTitle="Choose a turbo LoRA"
          options={options}
          allowRemove={false}
          allowSwap
        />
      )}
      {turbo.enabled && toAdd.status === 'fallback' && shown.id !== pick.id && (
        <Text size="xs" c="yellow.6" className="px-3 pb-3">
          Your turbo LoRA isn&apos;t available right now, so Turbo uses the ecosystem&apos;s
          default.
        </Text>
      )}
    </Stack>
  );
}
