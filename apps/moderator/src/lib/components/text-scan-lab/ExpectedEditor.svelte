<script lang="ts">
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { levelRank } from '$lib/text-scan-lab/expected';
  import {
    NSFW_LEVEL_NAMES,
    type Expected,
    type LabLabel,
    type NsfwLevelName,
  } from '$lib/text-scan-lab/types';

  // Posts the expectation as one JSON `expected` field. Only the entity type's own labels are
  // offered; the server re-validates (parseExpected), this only keeps the choices sensible.
  let {
    labels,
    expected = $bindable(),
    idPrefix,
  }: { labels: readonly LabLabel[]; expected: Expected; idPrefix: string } = $props();

  const UNSCORED = 'unscored';
  const flagLabels = $derived(labels.filter((l): l is 'poi' | 'minor' | 'scam' => l !== 'nsfw'));

  function setMin(v: string) {
    if (v === UNSCORED) {
      const { nsfw: _, ...rest } = expected;
      expected = rest;
      return;
    }
    const min = v as NsfwLevelName;
    const max =
      expected.nsfw && levelRank(expected.nsfw.max) >= levelRank(min) ? expected.nsfw.max : min;
    expected = { ...expected, nsfw: { min, max } };
  }
  function setMax(v: string) {
    if (!expected.nsfw) return;
    expected = { ...expected, nsfw: { ...expected.nsfw, max: v as NsfwLevelName } };
  }
  function setFlag(label: 'poi' | 'minor' | 'scam', v: string) {
    const { [label]: _, ...rest } = expected;
    expected = v === UNSCORED ? rest : { ...rest, [label]: v === 'yes' };
  }
  const flagValue = (label: 'poi' | 'minor' | 'scam') =>
    expected[label] === undefined ? UNSCORED : expected[label] ? 'yes' : 'no';
  const flagText = { yes: 'yes', no: 'no', [UNSCORED]: "don't score" } as Record<string, string>;
</script>

<input type="hidden" name="expected" value={JSON.stringify(expected)} />
<div class="flex flex-wrap items-end gap-3">
  {#if labels.includes('nsfw')}
    <div class="flex flex-col gap-1">
      <span class="text-xs text-dark-2" id="{idPrefix}-nsfw">nsfw min – max</span>
      <div class="flex items-center gap-1">
        <Select.Root type="single" bind:value={() => expected.nsfw?.min ?? UNSCORED, setMin}>
          <Select.Trigger class="w-32" aria-labelledby="{idPrefix}-nsfw">
            {expected.nsfw?.min ?? "don't score"}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value={UNSCORED}>don't score</Select.Item>
            {#each NSFW_LEVEL_NAMES as level (level)}
              <Select.Item value={level}>{level}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <span class="text-dark-2">–</span>
        <Select.Root
          type="single"
          disabled={!expected.nsfw}
          bind:value={() => expected.nsfw?.max ?? '', setMax}
        >
          <Select.Trigger class="w-24" aria-label="nsfw max">
            {expected.nsfw?.max ?? '—'}
          </Select.Trigger>
          <Select.Content>
            {#each NSFW_LEVEL_NAMES as level (level)}
              <Select.Item
                value={level}
                disabled={!!expected.nsfw && levelRank(level) < levelRank(expected.nsfw.min)}
              >
                {level}
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
    </div>
  {/if}
  {#each flagLabels as label (label)}
    <div class="flex flex-col gap-1">
      <span class="text-xs text-dark-2" id="{idPrefix}-{label}">{label}</span>
      <Select.Root type="single" bind:value={() => flagValue(label), (v) => setFlag(label, v)}>
        <Select.Trigger class="w-32" aria-labelledby="{idPrefix}-{label}">
          {flagText[flagValue(label)]}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="yes">yes</Select.Item>
          <Select.Item value="no">no</Select.Item>
          <Select.Item value={UNSCORED}>don't score</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
  {/each}
</div>
