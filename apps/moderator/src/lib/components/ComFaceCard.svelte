<script lang="ts">
  import { IconExternalLink } from '@tabler/icons-svelte';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { isComSafeLevel, type ComFace } from '$lib/com-face';
  import { getEdgeUrl } from '$lib/media/edge-url';

  /** A model's civitai.com face beside its .red one. Read-only. The cover shows unblurred, as every
   *  other tile in these queues does, unless the caller blurs it. */
  let {
    face,
    bare = false,
    blurred = false,
    onReveal,
  }: {
    face: ComFace | null;
    /** For a list row: no card around it, a smaller cover. */
    bare?: boolean;
    /** Hide the cover until the moderator reveals it; `onReveal` shows the Reveal button. */
    blurred?: boolean;
    onReveal?: () => void;
  } = $props();

  const cover = $derived(face?.cover ?? null);
  const comSafe = $derived(cover ? isComSafeLevel(cover.nsfwLevel) : true);
</script>

{#snippet body()}
  {#if face}
    <div class="flex gap-3">
      {#if cover}
        {@const media = cover.type === 'video' ? 'video' : 'image'}
        <div class="flex shrink-0 flex-col items-start gap-1">
        <svelte:element
          this={blurred ? 'div' : 'a'}
          href={blurred ? undefined : getEdgeUrl(cover.url, { type: media, original: true })}
          target={blurred ? undefined : '_blank'}
          rel={blurred ? undefined : 'noreferrer'}
          role={blurred ? 'img' : undefined}
          aria-label={blurred ? 'civitai.com cover, hidden' : 'Open the civitai.com cover'}
          class={cn(
            'relative block aspect-[4/5] shrink-0 overflow-hidden rounded-lg border bg-dark-6',
            bare ? 'w-16' : 'w-24',
            comSafe ? 'border-dark-4' : 'border-red-500'
          )}
        >
          <EdgeMedia
            src={cover.url}
            type={cover.type}
            anim={cover.type === 'video' ? false : undefined}
            width={200}
            hoverPlay={!blurred}
            class={blurred
              ? 'size-full scale-110 object-cover object-top blur-xl'
              : 'size-full object-cover object-top'}
          />
          <span
            class={cn(
              'pointer-events-none absolute bottom-1.5 left-1.5 rounded px-1.5 py-px text-[10px] font-semibold',
              comSafe ? 'bg-black/60 text-white' : 'bg-red-600 text-white'
            )}
          >
            {getBrowsingLevelLabel(cover.nsfwLevel)}{#if !comSafe}&nbsp;· not .com-safe{/if}
          </span>
        </svelte:element>
        {#if blurred && onReveal}
          <button
            type="button"
            class="text-[11px] text-blue-400 hover:underline"
            onclick={onReveal}>Reveal</button
          >
        {/if}
        </div>
      {/if}
      <div class="min-w-0 space-y-1.5">
        <p class="m-0 font-semibold break-words text-dark-0">{face.name}</p>
        {#if !cover}
          <p class="m-0 text-xs text-dark-2">
            {face.coverPicked ? 'The picked .com cover no longer exists' : 'No .com cover picked'};
            civitai.com shows another image
          </p>
        {/if}
        <a
          href={face.url}
          target="_blank"
          rel="noreferrer"
          class="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"
        >
          <IconExternalLink size={14} aria-hidden="true" /> Open on civitai.com
        </a>
      </div>
    </div>
  {:else}
    <p class="m-0 text-dark-2">No .com face</p>
  {/if}
{/snippet}

{#if bare}
  <div class="text-[13px]">
    <p class="m-0 mb-1.5 text-[11px] font-semibold tracking-[0.5px] text-dark-2">civitai.com face</p>
    {@render body()}
  </div>
{:else}
  <TriageCard dense title="civitai.com face">{@render body()}</TriageCard>
{/if}
