<script lang="ts">
  import { untrack } from 'svelte';
  import { isAbort, parseTraceLine, tailTrace, type TraceEvent } from '$lib/trace';

  let { traceUrl }: { traceUrl: string } = $props();

  const MAX_LINES = 400;
  interface Line {
    id: number;
    text: string;
    kind: 'log' | 'event' | 'error';
  }
  let lines = $state<Line[]>([]);
  let progress = $state<{ step: number; total: number } | null>(null);
  let phase = $state<string | null>(null);
  let started = $state(false);
  let seq = 0;

  const firstNumber = (...vals: unknown[]) =>
    vals.find((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const firstString = (...vals: unknown[]) =>
    vals.find((v): v is string => typeof v === 'string' && v.length > 0);

  function push(text: string, kind: Line['kind']) {
    lines.push({ id: ++seq, text, kind });
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  }

  // The exact event `type`s are written by the ai-toolkit worker, so read common field shapes rather than
  // assume names: a console/text line becomes a log; a step+total updates the progress bar; a `phase` or a
  // non-console `type` sets the phase; anything error-tagged is highlighted.
  function ingest(raw: string) {
    started = true;
    const parsed = parseTraceLine(raw);
    if (parsed.kind === 'text') {
      push(parsed.text, 'log');
      return;
    }
    const e = parsed.event;
    const step = firstNumber(e.step, e.currentStep, e.stepIndex, e.current, e.globalStep, e.numSteps);
    const total = firstNumber(e.totalSteps, e.total, e.steps, e.maxSteps, e.max, e.totalStep);
    if (step !== undefined && total !== undefined && total > 0) progress = { step, total };

    const type = typeof e.type === 'string' ? e.type : '';
    const ph = firstString(e.phase, type && !/console|log/i.test(type) ? type : undefined);
    if (ph) phase = ph;

    const isError = /error|fail/i.test(type) || e.level === 'error';
    const text = firstString(e.message, e.line, e.text, e.log, e.msg, e.content, e.output);
    // Show the recognized message, else the raw line — never hide a trainer event, so console step output
    // (and any field name I didn't anticipate) still shows in the log.
    push(text ?? raw, isError ? 'error' : text ? 'log' : 'event');
  }

  function sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    });
  }

  // The presigned trace URL is re-signed on every workflow poll, but its path is stable per epoch. Key the
  // tail on the PATH so a signature refresh doesn't re-run the effect and abort the open stream (which
  // showed up as every trace request being canceled every ~5s).
  const traceKey = $derived(traceUrl.split('?')[0]);

  // (Re)tail whenever the epoch (path) changes. Retries the 404 "not yet written" window, tails until the
  // stream closes, then waits for the next epoch's path.
  $effect(() => {
    void traceKey; // track the path only
    const url = untrack(() => traceUrl); // use the current signed URL without tracking its query
    lines = [];
    progress = null;
    phase = null;
    started = false;
    const controller = new AbortController();
    (async () => {
      while (!controller.signal.aborted) {
        let ready = false;
        try {
          ({ ready } = await tailTrace(url, ingest, controller.signal));
        } catch (err) {
          if (isAbort(err)) return;
          // transient error — fall through to the backoff below
        }
        if (ready) break;
        try {
          await sleep(2000, controller.signal);
        } catch {
          return; // aborted during backoff — sleep rejects, don't let it escape
        }
      }
    })();
    return () => controller.abort();
  });

  // Follow the tail as lines arrive.
  let logEl: HTMLDivElement | undefined;
  $effect(() => {
    lines.length;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });
</script>

<div class="overflow-hidden rounded-md border border-dark-4 bg-dark-7">
  <div class="flex items-center gap-2 border-b border-dark-4 px-4 py-2.5">
    <span class="h-2 w-2 animate-pulse rounded-full bg-primary"></span>
    <span class="text-sm font-semibold text-dark-0">Live trace</span>
    {#if phase}<span class="font-mono text-[11px] text-dark-2">· {phase}</span>{/if}
    {#if progress}
      <span class="ml-auto font-mono text-[11px] text-dark-2">
        step {progress.step.toLocaleString()} / {progress.total.toLocaleString()}
      </span>
    {/if}
  </div>
  {#if progress}
    <div class="h-1 bg-dark-6">
      <div
        class="h-1 bg-primary transition-[width]"
        style:width="{Math.min(100, (progress.step / progress.total) * 100)}%"
      ></div>
    </div>
  {/if}
  <div
    bind:this={logEl}
    role="log"
    aria-live="polite"
    class="max-h-64 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-relaxed"
  >
    {#if !started}
      <div class="text-dark-2">Waiting for the trainer to start streaming…</div>
    {:else}
      {#each lines as line (line.id)}
        <div
          class={line.kind === 'error'
            ? 'text-red-400'
            : line.kind === 'event'
              ? 'text-primary'
              : 'text-dark-1'}
        >
          {line.text}
        </div>
      {/each}
    {/if}
  </div>
</div>
