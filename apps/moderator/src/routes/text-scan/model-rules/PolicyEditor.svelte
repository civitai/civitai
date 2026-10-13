<script lang="ts">
  import * as Collapsible from '@civitai/ui/components/ui/collapsible/index.js';
  import PromptWorkspace from '$lib/components/text-scan-lab/PromptWorkspace.svelte';
  import { dateTime } from '$lib/format';
  import { denied } from '$lib/permissions';
  import type { ChangesState } from '$lib/text-scan-lab/changes';
  import { MODEL_RULES_POLICY_KEY } from '$lib/text-scan-lab/types';
  import type { LoadedPolicy } from './+page.server';

  let {
    changes,
    policy,
    authors,
    canEdit,
  }: {
    changes: ChangesState;
    policy: LoadedPolicy;
    authors: Record<number, string>;
    canEdit: boolean;
  } = $props();

  let open = $state(false);
  const latest = $derived(policy.ok ? policy.value.latest?.[MODEL_RULES_POLICY_KEY] : undefined);
  const drafted = $derived(changes.keys.includes(MODEL_RULES_POLICY_KEY));
</script>

<Collapsible.Root bind:open>
  <Collapsible.Trigger
    class="flex w-full items-baseline justify-between gap-2 rounded-xl border border-dark-4 bg-dark-6 px-5 py-3 text-left"
  >
    <span class="text-sm font-semibold text-white">
      Policy prompt
      {#if drafted}<span class="ml-2 text-xs font-normal text-amber-300">● unsaved</span>{/if}
    </span>
    <span class="text-xs text-dark-2">
      {latest ? `Saved ${dateTime(latest.createdAt)}` : 'Never saved'} · {open ? 'Hide' : 'Edit'}
    </span>
  </Collapsible.Trigger>
  <Collapsible.Content class="mt-2">
    {#if policy.ok}
      <PromptWorkspace
        promptKey={MODEL_RULES_POLICY_KEY}
        {changes}
        prompts={policy.value}
        {authors}
        canSave={canEdit}
        saveAction="?/savePolicy"
        restoreAction="?/restorePolicy"
        saveHint={denied('textScan.modelRules.edit')}
      />
    {:else}
      <p class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-red-300">
        {policy.error}
      </p>
    {/if}
  </Collapsible.Content>
</Collapsible.Root>
