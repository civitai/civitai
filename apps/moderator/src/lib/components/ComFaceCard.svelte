<script lang="ts">
  import { IconExternalLink } from '@tabler/icons-svelte';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { isComSafeLevel, type ComFace } from '$lib/com-face';
  import { getEdgeUrl } from '$lib/media/edge-url';

  /** A model's civitai.com face beside its .red one. Read-only: the cover is unblurred, as every
   *  other tile in these queues is. */
  let { face }: { face: ComFace | null } = $props();

  const cover = $derived(face?.cover ?? null);
  const comSafe = $derived(cover ? isComSafeLevel(cover.nsfwLevel) : true);
</script>

<TriageCard dense title="civitai.com face">
  {#if face}
    <div class="flex gap-3">
      {#if cover}
        {@const media = cover.type === 'video' ? 'video' : 'image'}
        <a
          href={getEdgeUrl(cover.url, { type: media, original: true })}
          target="_blank"
          rel="noreferrer"
          aria-label="Open the civitai.com cover"
          class={cn(
            'relative block aspect-[4/5] w-24 shrink-0 overflow-hidden rounded-lg border bg-dark-6',
            comSafe ? 'border-dark-4' : 'border-red-500'
          )}
        >
          <EdgeMedia
            src={cover.url}
            type={cover.type}
            anim={cover.type === 'video' ? false : undefined}
            width={200}
            class="size-full object-cover object-top"
          />
          <span
            class={cn(
              'pointer-events-none absolute bottom-1.5 left-1.5 rounded px-1.5 py-px text-[10px] font-semibold',
              comSafe ? 'bg-black/60 text-white' : 'bg-red-600 text-white'
            )}
          >
            {getBrowsingLevelLabel(cover.nsfwLevel)}{#if !comSafe}&nbsp;· not .com-safe{/if}
          </span>
        </a>
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
</TriageCard>
