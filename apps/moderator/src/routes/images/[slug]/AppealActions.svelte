<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import ImageCardModTools from './ImageCardModTools.svelte';
  import VerdictBadge from './VerdictBadge.svelte';

  let {
    item,
    verdict,
    selected,
    messages,
    submit,
  }: {
    item: { id: number; minor: boolean; poi: boolean };
    verdict: string | undefined;
    selected: SvelteSet<string | number>;
    /** imageId → resolution message. Held by the page so it survives this card re-rendering. */
    messages: SvelteMap<number, string>;
    submit: SubmitFunction;
  } = $props();

  const CHOICES = [
    {
      status: 'Approved',
      label: 'Approve',
      cls: 'border-emerald-600/40 text-emerald-400 hover:bg-emerald-500/10',
    },
    {
      status: 'Rejected',
      label: 'Reject',
      cls: 'border-rose-500/40 text-rose-400 hover:bg-rose-500/10',
    },
  ];
</script>

{#if verdict}
  <VerdictBadge {verdict} />
{:else}
  <div class="flex flex-col gap-1.5">
    <!-- No rating: an appeal's image is `Blocked`, and setting a level writes `nsfwLevelLocked` over
         a state the decision below is about to replace. -->
    <ImageCardModTools
      imageIds={String(item.id)}
      nsfwLevel={null}
      rating={false}
      minor={item.minor}
      poi={item.poi}
    />
    <!-- A selected card loses its own verdict buttons: pressing Approve there resolved the one appeal
         while the moderator believed it applied to the batch. -->
    {#if selected.has(item.id)}
      <span class="text-xs text-primary">In selection — resolve it from the bar below.</span>
    {:else}
      <textarea
        placeholder="Resolution message (optional)"
        value={messages.get(item.id) ?? ''}
        oninput={(e) => messages.set(item.id, e.currentTarget.value)}
        rows="2"
        maxlength={1000}
        class="w-full resize-none rounded border border-dark-4 bg-dark-6 px-2 py-1 text-xs"
      ></textarea>
      <div class="flex flex-wrap gap-1.5">
        {#each CHOICES as choice (choice.status)}
          <form method="POST" action="?/resolveAppeal" use:enhance={submit}>
            <input type="hidden" name="imageId" value={item.id} />
            <input type="hidden" name="status" value={choice.status} />
            <input type="hidden" name="resolvedMessage" value={messages.get(item.id) ?? ''} />
            <button
              type="submit"
              class="rounded border px-2 py-0.5 text-xs font-semibold transition {choice.cls}"
            >
              {choice.label}
            </button>
          </form>
        {/each}
      </div>
    {/if}
  </div>
{/if}
