<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import type { CheckResult, Seed } from './+page.server';
  import { changesStorageKey, seedOverwritesDraft } from './changes';
  import { createChanges } from './changes.svelte';
  import ChangesBar from './ChangesBar.svelte';
  import CheckForm from './CheckForm.svelte';
  import CheckItem from './CheckItem.svelte';
  import PromptEditor from './PromptEditor.svelte';

  let { data } = $props();

  const current = $derived(data.active.ok ? data.active.content : {});
  const changes = createChanges(untrack(() => data.user?.id ?? 0));
  const currentPrompts = () =>
    data.active.ok ? { content: data.active.content, ids: data.active.ids } : null;

  let editing = $state<PromptKey | null>(null);

  // The notice outlives the strip below, which re-runs `load` without the params.
  let seedNotice = $state(untrack(() => data.seedNotice));
  let pendingSeed = $state<Seed | null>(null);

  function applySeed(seed: Seed) {
    changes.seed(seed.key, seed.content);
    editing = seed.key;
  }

  // Versions links here with `?key=&from=`; the draft is set once, then the params go so a reload or
  // a shared link does not reseed.
  function seedFromLink() {
    const seed = data.seed;
    if (seed) {
      const draft = changes.prompts[seed.key];
      if (draft === seed.content) editing = seed.key;
      else if (seedOverwritesDraft(draft, seed.content)) pendingSeed = seed;
      else applySeed(seed);
    }
    if (seed || data.seedNotice) {
      // `replaceState` neither updates `page.url` nor works before the router starts; the first
      // microtask after mount is past hydration.
      void tick().then(() =>
        goto(page.url.pathname, {
          replaceState: true,
          noScroll: true,
          keepFocus: true,
          invalidateAll: false,
        })
      );
    }
  }

  let mounted = $state(false);
  onMount(() => {
    changes.restore(currentPrompts());
    seedFromLink();
    mounted = true;
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === changesStorageKey(data.user?.id ?? 0)) changes.reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });
  // After a publish reloads the page data: what went live stops being a change.
  $effect(() => {
    const next = currentPrompts();
    if (mounted) untrack(() => changes.setCurrent(next));
  });

  let result = $state<CheckResult | null>(null);
  let checkedWith = $state<string | null>(null);
  function startCheck() {
    result = null;
    checkedWith = changes.json;
  }
</script>

<svelte:head><title>Check · Text scan</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <h1 class="text-xl font-semibold text-white">Check</h1>
  <Button size="sm" variant="ghost" onclick={() => (editing = 'base')}>
    Edit general instructions
  </Button>
</div>

{#if seedNotice}
  <p role="status" class="mb-4 text-sm text-amber-300">{seedNotice}</p>
{/if}

{#if changes.keys.length}
  <ChangesBar
    {changes}
    canPublish={!!data.grants['textScan.prompt.publish'] && data.active.ok}
    onedit={(key) => (editing = key)}
  />
{/if}

<CheckForm
  overrides={changes.json}
  overridesError={changes.blankError}
  onstart={startCheck}
  onchecked={(r) => (result = r as CheckResult)}
/>

{#if result}
  <div id="check-results" class="mt-6 scroll-mt-4 space-y-4">
    {#if result.notice}
      <p class="text-sm text-amber-300">{result.notice}</p>
    {/if}
    {#if result.skipped.length}
      <p class="whitespace-pre-wrap text-sm text-amber-300">
        Couldn't load: {result.skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}
      </p>
    {/if}
    {#if checkedWith !== changes.json}
      <p class="text-sm text-amber-300">
        The changes were edited after this check — check again to see their effect.
      </p>
    {/if}
    {#each result.items as item (item.key)}
      <CheckItem {item} labels={result.labels} onedit={(key) => (editing = key)} />
    {/each}
  </div>
{/if}

<PromptEditor
  promptKey={editing}
  {changes}
  {current}
  currentError={data.active.ok ? null : data.active.error}
  onclose={() => (editing = null)}
/>

<AlertDialog.Root
  bind:open={
    () => pendingSeed !== null,
    (v) => {
      if (!v) pendingSeed = null;
    }
  }
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Replace your changes?</AlertDialog.Title>
      <AlertDialog.Description>
        You already have unpublished changes to {pendingSeed ? promptKeyName(pendingSeed.key) : ''}.
        Starting from version #{pendingSeed?.id} replaces them.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Keep my changes</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={() => {
          if (pendingSeed) applySeed(pendingSeed);
        }}>Replace</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
