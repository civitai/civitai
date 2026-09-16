<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { MultiCombobox } from '@civitai/ui/components/ui/multi-combobox/index.js';
  import { num } from '$lib/format';
  import { clearPaging } from '$lib/paging';
  import { urlWith, urlWithMulti } from '$lib/url';
  import { FEEDBACK_STATUSES } from '$lib/feedback';

  let {
    statuses,
    area,
    areaOptions,
    shown,
  }: {
    statuses: string[];
    area: string;
    areaOptions: string[];
    shown: number;
  } = $props();

  const statusOptions = FEEDBACK_STATUSES.map((s) => ({ value: s, label: s }));
  const areaLabel = $derived(area || 'Area — any');

  /**
   * Any filter change invalidates the keyset AND closes the open row: the cursor points into a
   * result set that no longer exists, and `?open=` can name a row the new filters exclude.
   */
  function clearedUrl() {
    const next = new URL(page.url);
    clearPaging(next.searchParams);
    next.searchParams.delete('open');
    return next;
  }

  // `emptyMeansAll`: an ABSENT `status` falls back to the default view, so a cleared filter has to
  // survive as `?status=` or clearing it silently reapplies `new`.
  const applyStatus = (values: string[]) =>
    goto(urlWithMulti(clearedUrl(), 'status', values, { emptyMeansAll: true }));
  const applyArea = (value: string) => goto(urlWith(clearedUrl(), { area: value || null }));
</script>

<div class="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3">
  <div class="flex flex-col gap-1">
    <!-- A span, not a `Label for=`: MultiCombobox takes no id, so a `for` would point at nothing. -->
    <span class="text-xs text-dark-2">Status</span>
    <!-- Function bindings on both controls: these primitives declare `value` as `$bindable` and
         write to it on interaction, so a plain prop leaves a child-local override that Svelte only
         discards when the parent yields a DIFFERENT value. `load` owns this state — the URL is the
         source of truth — so each control reads from it and writes through `goto`. -->
    <MultiCombobox
      options={statusOptions}
      bind:value={() => statuses, (v) => applyStatus(v)}
      placeholder="Search statuses…"
    />
  </div>

  <div class="flex flex-col gap-1">
    <Label for="feedback-area" class="text-xs text-dark-2">Area</Label>
    <Select.Root type="single" bind:value={() => area, (v) => applyArea(v ?? '')}>
      <Select.Trigger id="feedback-area" class="w-56">{areaLabel}</Select.Trigger>
      <Select.Content>
        <Select.Item value="">Area — any</Select.Item>
        {#each areaOptions as option (option)}
          <Select.Item value={option}>{option}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  <span class="pb-1.5 text-xs text-dark-2">{num(shown)} shown</span>
</div>
