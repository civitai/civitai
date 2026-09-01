<script lang="ts">
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { dateTime, num } from '$lib/format';
  import type { GeneratedWorkflowPage, WorkflowSource } from '$lib/server/user-workflows.service';

  const SOURCES: { value: WorkflowSource; label: string }[] = [
    { value: 'onsite', label: 'On-site generator' },
    { value: 'comfy', label: 'Comfy Cloud' },
  ];

  let {
    userId,
    title = 'Previous generations',
    // Collapsed by default: the orchestrator round trip costs a page load, and most rulings do not need
    // it. A page whose whole purpose is this panel passes `open`.
    open = false,
  }: { userId: number; title?: string; open?: boolean } = $props();

  // `null` while the toggle has not been touched, so a change to `open` still reaches the panel rather
  // than being frozen at whatever the prop was on the first render.
  let toggled = $state<boolean | null>(null);
  const shown = $derived(toggled ?? open);

  let source = $state<WorkflowSource>('onsite');

  // A stack of the cursors walked so far, so Previous is an index move rather than a second query the
  // orchestrator cannot answer (its paging is forward-only). `''` is the first page.
  let cursors = $state<string[]>(['']);
  let index = $state(0);

  // Reset on the SUBJECT, not on mount: a caller that swaps `userId` without a `{#key}` would otherwise
  // send page 3's cursor — an opaque token belonging to the previous account — as the new one's.
  $effect(() => {
    userId;
    untrack(() => {
      toggled = null;
      source = 'onsite';
    });
  });

  // A cursor belongs to one tag-filtered query, so a tab switch restarts the walk rather than handing
  // the new query the other tab's token.
  $effect(() => {
    userId;
    source;
    untrack(() => {
      cursors = [''];
      index = 0;
    });
  });

  const page = $derived(
    browser && shown
      ? fetch(
          `/api/user-workflows/${userId}?take=20&source=${source}${
            cursors[index] ? `&cursor=${encodeURIComponent(cursors[index])}` : ''
          }`
        ).then(async (r): Promise<GeneratedWorkflowPage> => {
          const body = await r.json();
          if (!r.ok) throw new Error(body?.error ?? String(r.status));
          return body;
        })
      : null
  );

  const advance = (nextCursor: string) => {
    if (cursors[index + 1] !== nextCursor) cursors = [...cursors.slice(0, index + 1), nextCursor];
    index += 1;
  };
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-sm font-semibold text-white">{title}</h3>
    <Button size="xs" variant="outline" onclick={() => (toggled = !shown)}>
      {shown ? 'Hide' : 'Show'}
    </Button>
  </div>
  <p class="mt-1 text-xs text-dark-2">
    What this account has successfully generated, newest first — read from the orchestrator, so it is
    not limited to what was published to the site.
  </p>

  {#if shown}
    <Tabs
      value={source}
      onValueChange={(v) => v && (source = v as WorkflowSource)}
      class="mt-3"
    >
      <TabsList>
        {#each SOURCES as s (s.value)}
          <TabsTrigger value={s.value}>{s.label}</TabsTrigger>
        {/each}
      </TabsList>
    </Tabs>

    {#if source === 'comfy'}
      <!-- Comfy Cloud submits no generation params, so the rows below carry media and nothing else.
           Saying so beats an empty prompt line reading as an account that prompted nothing. -->
      <p class="mt-2 text-xs text-dark-2">
        Comfy Cloud sends no prompt or model with a workflow — only its outputs are recorded.
      </p>
    {/if}

    {#await page}
      <p class="mt-3 text-sm text-dark-2">Loading generations…</p>
    {:then result}
      {#if result}
        {#if result.items.length === 0}
          <p class="mt-3 text-sm text-dark-2">
            No successful generations on record for this account
            {source === 'comfy' ? ' in Comfy Cloud' : ' on-site'}.
          </p>
        {:else}
          <ul class="mt-3 space-y-3">
            {#each result.items as workflow (workflow.id)}
              <li class="rounded-md border border-dark-4 p-3">
                <div class="flex flex-wrap items-center gap-2 text-xs text-dark-2">
                  <span>{dateTime(workflow.createdAt ? new Date(workflow.createdAt) : null)}</span>
                  {#if workflow.workflow}
                    <Badge variant="secondary">{workflow.workflow}</Badge>
                  {/if}
                  {#if workflow.ecosystem}
                    <Badge variant="secondary">{workflow.ecosystem}</Badge>
                  {/if}
                  {#if workflow.unavailable > 0}
                    <span class="text-amber-300">
                      {num(workflow.unavailable)} output{workflow.unavailable === 1 ? '' : 's'} no longer
                      served
                    </span>
                  {/if}
                </div>

                {#if workflow.prompt}
                  <p class="mt-1 wrap-break-word text-sm text-dark-0">{workflow.prompt}</p>
                {/if}
                {#if workflow.negativePrompt}
                  <p class="mt-1 wrap-break-word text-xs text-dark-2">
                    <span class="text-dark-2">neg:</span>
                    {workflow.negativePrompt}
                  </p>
                {/if}

                {#if workflow.media.length}
                  <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {#each workflow.media as media, i (media.id + '@' + i)}
                      <!-- The orchestrator's URLs are signed and expire; nothing is proxied, so a stale
                           panel shows broken tiles rather than leaking a re-signable link. -->
                      {#if media.type === 'video'}
                        <video src={media.url} controls muted class="w-full rounded"></video>
                      {:else}
                        <img src={media.url} alt="" loading="lazy" class="w-full rounded" />
                      {/if}
                    {/each}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>

          <div class="mt-3 flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={index === 0}
              onclick={() => (index = Math.max(0, index - 1))}
            >
              Previous
            </Button>
            <span class="text-xs text-dark-2">Page {num(index + 1)}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={!result.nextCursor}
              onclick={() => result.nextCursor && advance(result.nextCursor)}
            >
              Next
            </Button>
          </div>
        {/if}
      {/if}
    {:catch e}
      <p class="mt-3 text-sm text-red-300">Could not load generations: {e.message}</p>
    {/await}
  {/if}
</section>
