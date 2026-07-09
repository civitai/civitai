<script lang="ts">
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import { ScrollArea } from '@civitai/ui/components/ui/scroll-area/index.js';
  import type {
    PromptHighlightCategory,
    PromptHighlightResult,
    PromptSegment,
  } from '@civitai/mod-utils/prompt-audit';

  let { result, label = 'prompt' }: { result: PromptHighlightResult; label?: string } = $props();

  const MARK: Record<PromptHighlightCategory, string> = {
    minor: 'bg-violet-500/25 text-violet-200',
    young: 'bg-sky-500/25 text-sky-200',
    poi: 'bg-teal-500/25 text-teal-100',
    blocked: 'bg-rose-600/30 text-rose-100',
    nsfw: 'bg-orange-500/25 text-orange-100',
  };

  // Context chars kept around each highlight in the compact card excerpt.
  const CTX = 36;

  function excerpt(segments: PromptSegment[]): PromptSegment[] {
    const flagged = segments.some((s) => s.category !== null);
    if (!flagged) {
      const text = segments.map((s) => s.text).join('');
      const head = text.slice(0, CTX * 2);
      return [{ text: head + (text.length > head.length ? ' …' : ''), category: null }];
    }
    const out: PromptSegment[] = [];
    segments.forEach((seg, k) => {
      if (seg.category !== null) return out.push(seg);
      const t = seg.text;
      if (t.length <= CTX * 2) return out.push(seg);
      const isFirst = k === 0;
      const isLast = k === segments.length - 1;
      if (isFirst) out.push({ text: '… ' + t.slice(t.length - CTX), category: null });
      else if (isLast) out.push({ text: t.slice(0, CTX) + ' …', category: null });
      else out.push({ text: t.slice(0, CTX) + ' … ' + t.slice(t.length - CTX), category: null });
    });
    return out;
  }

  const promptExcerpt = $derived(excerpt(result.prompt));
  const negExcerpt = $derived(result.negativePrompt ? excerpt(result.negativePrompt) : null);
  const hasNeg = $derived((result.negativePrompt?.length ?? 0) > 0);
</script>

{#snippet segs(segments: PromptSegment[])}
  {#each segments as seg, i (i)}
    {#if seg.category}
      <mark class="rounded-sm px-0.5 {MARK[seg.category]}">{seg.text}</mark>
    {:else}{seg.text}{/if}
  {/each}
{/snippet}

<div class="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/30 p-2">
  <p class="whitespace-pre-wrap break-words text-xs leading-snug">
    {@render segs(promptExcerpt)}
  </p>
  <Popover.Root>
    <Popover.Trigger class="w-fit text-[11px] font-medium text-primary hover:underline">
      View full {label}
    </Popover.Trigger>
    <Popover.Content
      align="start"
      class="w-[min(32rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]"
    >
      <p class="text-xs font-semibold uppercase text-muted-foreground">Full {label}</p>
      <ScrollArea class="max-h-[60vh] pr-3">
        <div class="flex flex-col gap-3">
          <div>
            <p class="mb-1 text-xs font-semibold uppercase text-muted-foreground">Prompt</p>
            <p class="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {@render segs(result.prompt)}
            </p>
          </div>
          {#if hasNeg && result.negativePrompt}
            <div>
              <p class="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                Negative prompt
              </p>
              <p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                {@render segs(result.negativePrompt)}
              </p>
            </div>
          {/if}
        </div>
      </ScrollArea>
    </Popover.Content>
  </Popover.Root>
</div>

{#if negExcerpt && negExcerpt.some((s) => s.category)}
  <p class="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug text-muted-foreground">
    <span class="font-semibold">Neg:</span>
    {@render segs(negExcerpt)}
  </p>
{/if}
