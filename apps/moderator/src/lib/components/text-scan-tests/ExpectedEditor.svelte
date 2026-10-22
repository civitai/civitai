<script lang="ts">
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { LABEL_NAMES, RATING_NAMES } from '$lib/text-scan-lab/labels';
  import { NSFW_LEVEL_NAMES, type LabLabel, type NsfwLevelName } from '$lib/text-scan-lab/types';
  import {
    FLAG_LABELS,
    levelRank,
    type Expected,
    type FlagLabel,
  } from '$lib/text-scan-tests/expected';

  let {
    labels,
    expected = $bindable(),
    idPrefix,
  }: {
    labels: readonly LabLabel[];
    expected: Expected;
    idPrefix: string;
  } = $props();

  const UNSCORED = 'unscored';
  const FLAG_TEXT: Record<string, string> = { yes: 'Yes', no: 'No', [UNSCORED]: "Don't score" };
  const flagLabels = $derived(
    labels.filter((l): l is FlagLabel => (FLAG_LABELS as readonly LabLabel[]).includes(l))
  );

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
    if (expected.nsfw) expected = { ...expected, nsfw: { ...expected.nsfw, max: v as NsfwLevelName } };
  }

  const flagValue = (label: FlagLabel) =>
    expected[label] === undefined ? UNSCORED : expected[label] ? 'yes' : 'no';

  function setFlag(label: FlagLabel, v: string) {
    const { [label]: _, ...rest } = expected;
    expected = v === UNSCORED ? rest : { ...rest, [label]: v === 'yes' };
  }
</script>

<input type="hidden" name="expected" value={JSON.stringify(expected)} />
<div class="space-y-3">
  {#if labels.includes('nsfw')}
    <div>
      <span class="text-xs text-dark-2" id="{idPrefix}-nsfw">{LABEL_NAMES.nsfw}: lowest to highest</span>
      <div class="mt-1 flex items-center gap-1">
        <Select.Root type="single" bind:value={() => expected.nsfw?.min ?? UNSCORED, setMin}>
          <Select.Trigger class="w-36" aria-labelledby="{idPrefix}-nsfw">
            {expected.nsfw ? RATING_NAMES[expected.nsfw.min] : "Don't score"}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value={UNSCORED}>Don't score</Select.Item>
            {#each NSFW_LEVEL_NAMES as level (level)}
              <Select.Item value={level}>{RATING_NAMES[level]}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <span class="text-dark-2">–</span>
        <Select.Root
          type="single"
          disabled={!expected.nsfw}
          bind:value={() => expected.nsfw?.max ?? '', setMax}
        >
          <Select.Trigger class="w-28" aria-label="{LABEL_NAMES.nsfw} highest">
            {expected.nsfw ? RATING_NAMES[expected.nsfw.max] : '—'}
          </Select.Trigger>
          <Select.Content>
            {#each NSFW_LEVEL_NAMES as level (level)}
              <Select.Item
                value={level}
                disabled={!!expected.nsfw && levelRank(level) < levelRank(expected.nsfw.min)}
              >
                {RATING_NAMES[level]}
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
    </div>
  {/if}

  {#each flagLabels as label (label)}
    <div>
      <span class="text-xs text-dark-2" id="{idPrefix}-{label}">{LABEL_NAMES[label]}</span>
      <Select.Root type="single" bind:value={() => flagValue(label), (v) => setFlag(label, v)}>
        <Select.Trigger class="mt-1 w-36" aria-labelledby="{idPrefix}-{label}">
          {FLAG_TEXT[flagValue(label)]}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="yes">Yes</Select.Item>
          <Select.Item value="no">No</Select.Item>
          <Select.Item value={UNSCORED}>Don't score</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
  {/each}
</div>
