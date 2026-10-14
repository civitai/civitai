<script lang="ts">
  import { browser } from '$app/environment';
  import * as Sheet from '@civitai/ui/components/ui/sheet/index.js';
  import RestoreDialog from '$lib/components/text-scan-lab/RestoreDialog.svelte';
  import { fetchJson } from '$lib/fetch-json';
  import { dateTime } from '$lib/format';
  import type { ModelRuleVersionView } from '$lib/model-rule-versions';
  import RuleVersionCompare from './RuleVersionCompare.svelte';

  let {
    ruleId = $bindable(null),
    subject = null,
    canEdit,
  }: { ruleId?: number | null; subject?: string | null; canEdit: boolean } = $props();

  let refresh = $state(0);
  const versions = $derived(
    browser && ruleId !== null
      ? fetchJson<ModelRuleVersionView[]>(
          `/text-scan/model-rules/history?rule=${ruleId}&v=${refresh}`
        )
      : null
  );
</script>

<Sheet.Root bind:open={() => ruleId !== null, (open) => !open && (ruleId = null)}>
  <Sheet.Content
    side="right"
    class="overflow-y-auto p-5 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
  >
    <Sheet.Header class="p-0">
      <Sheet.Title class="text-white">History · {subject ?? `#${ruleId}`}</Sheet.Title>
      <Sheet.Description class="text-dark-2">
        Every save, enable, disable and restore. Restoring saves an old version as the rule's new
        version.
      </Sheet.Description>
    </Sheet.Header>
    {#if versions}
      {#await versions}
        <p class="text-sm text-dark-2">Loading…</p>
      {:then list}
        {#if !list?.length}
          <p class="text-sm text-dark-2">
            No versions recorded yet. This rule was last saved before history was kept; its next save
            records how it looked before and after.
          </p>
        {:else}
          {#key ruleId}
            <RuleVersionCompare versions={list} />
          {/key}
          <ul class="space-y-2">
            {#each list as version, i (version.id)}
              <li
                class="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-dark-4 p-2"
              >
                <div class="min-w-0">
                  <p class="text-sm text-dark-0">
                    #{version.id} · {dateTime(version.createdAt)} · by
                    {version.createdBy ?? `user ${version.createdById}`}{i === 0 ? ' (current)' : ''}
                  </p>
                  <p class="break-words text-xs text-dark-2">
                    {version.subject} · {version.enabled ? 'enabled' : 'disabled'}{version.needsAttention
                      ? ' · needs attention'
                      : ''}{version.legacy ? ' · regex' : ''}
                  </p>
                </div>
                {#if canEdit && i > 0 && !version.legacy && ruleId !== null}
                  <RestoreDialog
                    action="?/restoreRule"
                    title="Restore version #{version.id}"
                    description="Saves this definition and enabled state as the rule's new version. Scans use it from the next scan on."
                    fields={{ ruleId, versionId: version.id }}
                    withNote={false}
                    onrestored={() => refresh++}
                  />
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {:catch}
        <p class="text-sm text-red-300">Could not load this rule's history.</p>
      {/await}
    {/if}
  </Sheet.Content>
</Sheet.Root>
