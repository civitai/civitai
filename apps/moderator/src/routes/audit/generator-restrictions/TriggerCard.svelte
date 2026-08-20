<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import HighlightedText from './HighlightedText.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { RestrictionTriggerView } from '$lib/server/user-restriction.service';

  let {
    trigger,
    selected,
    onToggle,
    civitaiUrl,
  }: {
    trigger: RestrictionTriggerView;
    selected: boolean;
    onToggle: (key: string) => void;
    civitaiUrl: string;
  } = $props();
</script>

<div
  class="rounded-xl border p-4 {selected
    ? 'border-amber-500/50 bg-amber-500/10'
    : 'border-dark-4 bg-dark-6'}"
>
  <div class="grid gap-4 md:grid-cols-[16rem_1fr]">
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <!-- The parent owns the selection set, so a plain prop would latch on the primitive's own write. -->
        <Checkbox
          id="flag-{trigger.key}"
          bind:checked={() => selected, () => onToggle(trigger.key)}
        />
        <Label for="flag-{trigger.key}" class="font-normal text-dark-0">Flag as suspicious</Label>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        {#if trigger.source}<Badge variant="outline">{trigger.source}</Badge>{/if}
        {#if trigger.category}<Badge variant="destructive">{trigger.category}</Badge>{/if}
      </div>

      {#if trigger.matchedWord}
        <div>
          <p class="text-xs text-dark-2">Matched text</p>
          <code class="text-sm break-all text-dark-0">{trigger.matchedWord}</code>
        </div>
      {/if}
      {#if trigger.matchedRegex}
        <div>
          <p class="text-xs text-dark-2">Regex pattern</p>
          <code class="text-xs break-all text-dark-0">{trigger.matchedRegex}</code>
        </div>
      {/if}
      {#if trigger.time}
        <div>
          <p class="text-xs text-dark-2">Time</p>
          <p class="text-xs text-dark-0">{dateTime(trigger.time)}</p>
        </div>
      {/if}
    </div>

    <div class="min-w-0">
      {#if trigger.prompt}
        <p class="mb-1 text-xs font-semibold tracking-wide text-dark-2 uppercase">Prompt</p>
        <div class="max-h-48 overflow-auto rounded-md border border-dark-4 bg-dark-7 p-2">
          <HighlightedText text={trigger.prompt} highlight={trigger.matchedWord} />
        </div>
      {/if}
      {#if trigger.negativePrompt}
        <p class="mt-2 mb-1 text-xs font-semibold tracking-wide text-dark-2 uppercase">Negative</p>
        <div class="max-h-48 overflow-auto rounded-md border border-dark-4 bg-dark-7 p-2">
          <HighlightedText text={trigger.negativePrompt} highlight={trigger.matchedWord} />
        </div>
      {/if}

      {#if trigger.inputImages?.length || trigger.inputVideo || trigger.remixOfId}
        <p class="mt-3 mb-1 text-xs font-semibold tracking-wide text-dark-2 uppercase">
          Input media
        </p>
        <div class="flex flex-wrap items-center gap-2">
          {#each trigger.inputImages ?? [] as url, i (`${i}:${url}`)}
            <a href={url} target="_blank" rel="noreferrer">
              <img
                src={url}
                alt="Input"
                class="size-24 rounded border border-dark-4 object-cover"
              />
            </a>
          {/each}
          {#if trigger.inputVideo}
            <!-- Labelled explicitly: the link's only child is a video, so it has no text to name it
                 and a screen reader announces the bare URL. The sibling image links above get their
                 name from the img's `alt`. -->
            <a
              href={trigger.inputVideo}
              target="_blank"
              rel="noreferrer"
              aria-label="Open the input video in a new tab"
            >
              <video
                src={trigger.inputVideo}
                muted
                class="size-24 rounded border border-dark-4 object-cover"
              ></video>
            </a>
          {/if}
          {#if trigger.remixOfId}
            <a
              href="{civitaiUrl}/images/{trigger.remixOfId}"
              target="_blank"
              rel="noreferrer"
              class="{LINK_CLASS} text-xs"
            >
              Remixed image #{trigger.remixOfId}
            </a>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
