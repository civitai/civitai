<script lang="ts">
  import * as Sheet from '@civitai/ui/components/ui/sheet/index.js';
  import { dateTime } from '$lib/format';
  import type { LabPromptVersion } from '$lib/server/text-scan-lab/harness-client';
  import { resolvePair } from '$lib/text-scan-lab/compare';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import DiffView from './DiffView.svelte';
  import RestoreDialog from './RestoreDialog.svelte';
  import VersionPicker from './VersionPicker.svelte';

  let {
    open = $bindable(false),
    promptKey,
    versions,
    currentId,
    authors,
    canSave,
    action,
  }: {
    open?: boolean;
    promptKey: PromptKey;
    versions: LabPromptVersion[];
    currentId: number | null;
    authors: Record<number, string>;
    canSave: boolean;
    action: string;
  } = $props();

  const sorted = $derived([...versions].sort((a, b) => b.id - a.id));
  let picked = $state<{ from: number; to: number } | null>(null);
  const pair = $derived(resolvePair(picked, sorted));
  const byId = (id: number) => sorted.find((v) => v.id === id);
  const label = (v: LabPromptVersion) =>
    `#${v.id} · ${dateTime(v.createdAt)}${v.id === currentId ? ' (current)' : ''}`;
  const options = $derived(sorted.map((v) => ({ id: v.id, label: label(v) })));
  const author = (id: number | null) => (id == null ? 'unknown' : authors[id] ?? 'unknown');
</script>

<Sheet.Root bind:open={() => open, (v) => (open = v)}>
  <Sheet.Content
    side="right"
    class="overflow-y-auto p-5 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
  >
    <Sheet.Header class="p-0">
      <Sheet.Title class="text-white">History · {promptKeyName(promptKey)}</Sheet.Title>
      <Sheet.Description class="text-dark-2">
        The last {sorted.length} versions. Restoring saves an old version's text as a new version.
      </Sheet.Description>
    </Sheet.Header>

    {#if pair}
      {@const from = pair.from}
      {@const to = pair.to}
      <div class="flex flex-wrap items-end gap-3">
        <VersionPicker
          id="prompt-compare-from"
          label="From"
          value={from}
          {options}
          onchange={(id) => (picked = { from: id, to })}
        />
        <VersionPicker
          id="prompt-compare-to"
          label="To"
          value={to}
          {options}
          onchange={(id) => (picked = { from, to: id })}
        />
      </div>
      <DiffView before={byId(from)?.content ?? ''} after={byId(to)?.content ?? ''} />
    {/if}

    {#if sorted.length}
      <ul class="space-y-2">
        {#each sorted as version (version.id)}
          <li
            class="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-dark-4 p-2"
          >
            <div class="min-w-0">
              <p class="text-sm text-dark-0">{label(version)} · by {author(version.createdById)}</p>
              {#if version.note}
                <p class="text-xs text-dark-2">{version.note}</p>
              {/if}
            </div>
            {#if canSave && currentId !== null && version.id !== currentId}
              <RestoreDialog
                {action}
                title="Restore version #{version.id}"
                description="Saves this text as a new version of {promptKeyName(promptKey)}. Every scan uses it immediately; the versions in between stay in the history."
                fields={{ key: promptKey, id: version.id, baseId: currentId }}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-sm text-dark-2">No versions saved yet.</p>
    {/if}
  </Sheet.Content>
</Sheet.Root>
