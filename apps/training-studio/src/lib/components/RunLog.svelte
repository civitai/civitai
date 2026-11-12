<script lang="ts">
  import { untrack } from 'svelte';
  import { IconDownload, IconTerminal2 } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { browser } from '$lib/host';
  import type { EpochTrace } from '$lib/data/trainingRows';
  import { saveBlob } from '$lib/dataset-zip';
  import { slugify } from '$lib/slug';
  import { followTrace, interpretTraceLine, traceLineText, traceLogText, tracePath } from '$lib/trace';

  // The live panel only exists while training, so a finished run's log is read back from its epochs'
  // traces here.
  let { traces, name }: { traces: EpochTrace[]; name: string } = $props();

  interface Section {
    epoch: number;
    path: string;
    lines: string[];
    readable: boolean;
  }

  // The orchestrator holds a trace request open until its first byte, so an epoch that never started
  // (a canceled run) would otherwise read forever.
  const FIRST_LINE_TIMEOUT_MS = 15_000;

  const destroyed = new AbortController();
  $effect(() => () => destroyed.abort());

  async function readSection(trace: EpochTrace): Promise<Section> {
    const path = tracePath(trace.url);
    const controller = new AbortController();
    const abort = () => controller.abort();
    destroyed.signal.addEventListener('abort', abort, { once: true });
    const stall = setTimeout(abort, FIRST_LINE_TIMEOUT_MS);
    const lines: string[] = [];
    let failures = 0;
    let readable = false;
    try {
      const attempt = await followTrace(
        // Re-read per attempt: a poll re-signs the URL.
        () => untrack(() => traces).find((t) => tracePath(t.url) === path)?.url ?? trace.url,
        (line) => {
          clearTimeout(stall);
          lines.push(line);
        },
        controller.signal,
        (attempt) => attempt === 'failed' && ++failures < 3
      );
      readable = attempt === 'complete';
    } catch {
      // aborted: stalled or the panel went away
    } finally {
      clearTimeout(stall);
      destroyed.signal.removeEventListener('abort', abort);
    }
    return { epoch: trace.epoch, path, lines, readable };
  }

  // One epoch at a time: in order, and under the browser's per-host connection limit.
  async function readLog(targets: EpochTrace[]): Promise<Section[]> {
    const sections: Section[] = [];
    for (const trace of targets) sections.push(await readSection(trace));
    return sections;
  }

  // Read only once the panel is first opened; `attempt` re-reads on Retry.
  let requested = $state(false);
  let attempt = $state(0);
  const log = $derived(
    browser && requested
      ? (void attempt, readLog(untrack(() => traces)))
      : new Promise<Section[]>(() => {})
  );

  // Per-step loss readings are the loss graph's; on screen they'd bury every other line.
  const visibleLines = (section: Section) =>
    section.lines.filter((l) => interpretTraceLine(l).kind !== 'loss').map(traceLineText);

  function download(sections: Section[]) {
    saveBlob(
      new Blob([traceLogText(sections.filter((s) => s.lines.length))], { type: 'text/plain' }),
      `${slugify(name, 'training')}-training-log.txt`
    );
  }
</script>

<details
  ontoggle={(e) => {
    if (e.currentTarget.open) requested = true;
  }}
  class="overflow-hidden rounded-xl border border-dark-4 bg-dark-6"
>
  <summary
    class="flex select-none items-center gap-2 px-5 py-3 text-sm font-semibold text-dark-0 hover:bg-dark-5/40 [&::-webkit-details-marker]:hidden"
  >
    <IconTerminal2 size={16} stroke={2} class="text-dark-2" />
    Raw log
  </summary>

  <div class="border-t border-dark-4 p-5">
    {#await log}
      <span class="flex items-center gap-2 font-mono text-xs text-dark-2">
        <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-dark-2"></span>
        Reading the log…
      </span>
    {:then sections}
      {@const shown = sections.map((s) => ({ ...s, text: visibleLines(s) }))}
      {@const unreadable = sections.filter((s) => !s.readable)}
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!sections.some((s) => s.lines.length)}
          onclick={() => download(sections)}
        >
          <IconDownload size={14} stroke={2} class="mr-1.5 inline" />Download log
        </Button>
        {#if unreadable.length}
          <span class="font-mono text-xs text-red-400">
            Couldn't read the log for {unreadable.map((s) => `E${s.epoch}`).join(', ')}.
          </span>
          <Button variant="outline" size="sm" onclick={() => attempt++}>Retry</Button>
        {/if}
      </div>

      <div
        role="log"
        class="max-h-96 overflow-y-auto rounded border border-dark-5 bg-dark-8 px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {#each shown as section (section.path)}
          {#if section.text.length}
            <div class="sticky top-0 bg-dark-8 py-1 text-dark-1">Epoch {section.epoch}</div>
            {#each section.text as text, i (i)}
              <div class="whitespace-pre-wrap break-all text-dark-2">{text}</div>
            {/each}
          {/if}
        {/each}
        {#if !shown.some((s) => s.text.length)}
          <div class="text-dark-2">No log lines were recorded for this run.</div>
        {/if}
      </div>
    {:catch}
      <p class="m-0 text-sm text-red-400">
        Couldn't read the log.
        <Button variant="outline" size="sm" onclick={() => attempt++}>Retry</Button>
      </p>
    {/await}
  </div>
</details>
