<script lang="ts">
  import { untrack } from 'svelte';
  import {
    isAbort,
    interpretTraceLine,
    PHASE_LABEL,
    tailTrace,
    traceLineText,
    type TrainingPhase,
  } from '$lib/trace';

  let {
    traceUrl,
    plannedEpochs = null,
    currentEpoch = null,
  }: {
    traceUrl: string;
    /** The run's requested epoch count — lets the step bar read per-epoch instead of duplicating the
     *  header's overall bar. Null (unknown) falls back to the run-global step readout. */
    plannedEpochs?: number | null;
    /** The epoch being trained per the workflow poll — the label fallback until the trace's own
     *  attempt/phase events name one. */
    currentEpoch?: number | null;
  } = $props();

  const MAX_RAW = 400;

  let phase = $state<TrainingPhase | null>(null);
  let epoch = $state<number | null>(null);
  let step = $state<number | null>(null);
  let maxSteps = $state<number | null>(null);
  let stepsRemaining = $state<number | null>(null);
  let secondsPerStep = $state<number | null>(null);
  let raw = $state<string[]>([]);
  let started = $state(false);
  let seq = 0;
  let rawLines = $derived(raw.map((text, i) => ({ id: seq - raw.length + i, text: traceLineText(text) })));

  function ingest(line: string) {
    started = true;
    raw.push(line);
    seq++;
    if (raw.length > MAX_RAW) raw.splice(0, raw.length - MAX_RAW);

    const s = interpretTraceLine(line);
    switch (s.kind) {
      case 'attempt':
        if (s.epoch !== null) epoch = s.epoch;
        step = maxSteps = stepsRemaining = secondsPerStep = null;
        break;
      case 'phase':
        phase = s.phase;
        if (s.epoch !== null) epoch = s.epoch;
        // Leaving `training` for a save/sample phase — the step bar no longer reflects the live phase.
        if (s.phase !== 'training') step = null;
        break;
      case 'step':
        phase = 'training';
        step = s.step;
        maxSteps = s.maxSteps;
        stepsRemaining = s.stepsRemaining;
        secondsPerStep = s.secondsPerStep;
        break;
      case 'epoch-done':
        step = maxSteps = stepsRemaining = secondsPerStep = null;
        break;
      case 'noise':
        break;
    }
  }

  const phaseLabel = $derived(phase ? PHASE_LABEL[phase] : null);
  // The worker's `step`/`maxSteps` are RUN-GLOBAL (the counter climbs across epoch boundaries), so a
  // bar over them duplicates the header's overall progress. Scope this panel to the current epoch:
  // steps-per-epoch from the plan, position from the worker's own epoch-scoped `epochStepsRemaining`
  // when it's present, else the global counter folded into the epoch.
  const stepsPerEpoch = $derived(
    maxSteps && plannedEpochs && plannedEpochs > 0
      ? Math.max(1, Math.round(maxSteps / plannedEpochs))
      : null
  );
  const epochStep = $derived.by(() => {
    if (step === null || stepsPerEpoch === null) return null;
    if (stepsRemaining !== null)
      return Math.min(stepsPerEpoch, Math.max(0, stepsPerEpoch - stepsRemaining));
    // Fold the global counter into the epoch. The epoch index is clamped so the FINAL epoch absorbs
    // the rounding remainder when maxSteps doesn't divide evenly — a plain modulo wraps the bar back
    // to ~0% on the run's last steps, which reads as the run restarting.
    const epochIndex = Math.min(
      Math.floor((Math.max(1, step) - 1) / stepsPerEpoch),
      (plannedEpochs ?? 1) - 1
    );
    return Math.min(stepsPerEpoch, Math.max(1, step) - epochIndex * stepsPerEpoch);
  });
  // The trace's checkpoint epoch (attempt/phase events) wins; the poll-derived one covers the gap
  // before the first such event arrives.
  const epochLabel = $derived(epoch ?? currentEpoch);
  const stepPct = $derived.by(() => {
    if (epochStep !== null && stepsPerEpoch !== null)
      return Math.min(100, Math.max(0, (epochStep / stepsPerEpoch) * 100));
    return step !== null && maxSteps ? Math.min(100, Math.max(0, (step / maxSteps) * 100)) : 0;
  });
  const etaSeconds = $derived(
    phase === 'training' && stepsRemaining !== null && secondsPerStep !== null && stepsRemaining > 0
      ? Math.round(stepsRemaining * secondsPerStep)
      : null
  );

  function fmtEta(s: number): string {
    if (s < 60) return `~${s}s`;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return sec ? `~${m}m ${sec}s` : `~${m}m`;
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

  // (Re)tail whenever the epoch (path) changes. We deliberately DON'T reset the visible summary here: the
  // orchestrator pre-creates every epoch's trace and marks them done as weights land, so at a boundary we
  // switch to the next epoch's stream — which may 404 for a moment (not written yet) or already be closed
  // (a fast epoch that finished between polls). Blanking to "Waiting…" or snapping the phase back on every
  // switch is the jarring jump; instead we keep the last live view until the new stream replaces it, and the
  // global step counter (x / totalSteps) only ever climbs, so it reads as continuous progress.
  $effect(() => {
    void traceKey; // re-tail on the epoch (path) change; keep the last view until new data arrives
    const controller = new AbortController();
    (async () => {
      while (!controller.signal.aborted) {
        let ready = false;
        try {
          // Read the freshest signed URL each attempt. The parent re-signs it every poll, but this effect
          // is keyed on the PATH, so it never re-runs for a signature refresh — a once-captured URL would
          // expire mid-retry and get stuck 404/403-looping, which is one way an epoch never streamed.
          const url = untrack(() => traceUrl);
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

  // Follow the raw tail as lines arrive (only matters while the log is expanded).
  let logEl: HTMLDivElement | undefined;
  $effect(() => {
    raw.length;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });
</script>

<div class="overflow-hidden rounded-xl border border-dark-4 bg-dark-7">
  <div class="flex items-center gap-2 border-b border-dark-4 px-4 py-2.5">
    <span class="h-2 w-2 animate-pulse rounded-full bg-primary"></span>
    <span class="text-sm font-semibold text-dark-0">Live progress</span>
    {#if phaseLabel}
      <span class="text-sm text-dark-1">
        {phaseLabel}{#if epochLabel !== null}<span class="text-dark-2"> · epoch {epochLabel}</span>{/if}
      </span>
    {/if}
  </div>

  <div class="px-4 py-3">
    {#if !started}
      <div class="flex items-center gap-2 text-sm text-dark-1">
        <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-dark-2"></span>
        Trainer is starting up — the live feed begins with the first training step.
      </div>
    {:else if phase === 'training' && step !== null && maxSteps}
      <div class="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
        {#if epochStep !== null && stepsPerEpoch !== null}
          <span class="text-dark-1">
            step {epochStep.toLocaleString()} / {stepsPerEpoch.toLocaleString()}{#if epochLabel !== null}<span
                class="text-dark-2"
              > · epoch {epochLabel}</span
              >{/if}
          </span>
        {:else}
          <span class="text-dark-1">step {step.toLocaleString()} / {maxSteps.toLocaleString()} overall</span>
        {/if}
        {#if etaSeconds !== null}
          <span class="font-mono text-xs text-dark-2">{fmtEta(etaSeconds)} left in this epoch</span>
        {/if}
      </div>
      <div class="h-1.5 overflow-hidden rounded-full bg-dark-5">
        <div class="h-full rounded-full bg-primary transition-[width]" style:width="{stepPct}%"></div>
      </div>
      {#if secondsPerStep !== null}
        <div class="mt-1 font-mono text-xs text-dark-2">{secondsPerStep.toFixed(2)}s / step</div>
      {/if}
    {:else}
      <div class="flex items-center gap-2 text-sm text-dark-1">
        <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-dark-2"></span>
        {phaseLabel ?? 'Working'}…
      </div>
    {/if}

    <details class="mt-3">
      <summary
        class="cursor-pointer select-none font-mono text-xs uppercase tracking-wider text-dark-2 hover:text-dark-1"
      >
        Raw log ({raw.length})
      </summary>
      <div
        bind:this={logEl}
        role="log"
        aria-live="off"
        class="mt-2 max-h-64 overflow-y-auto rounded border border-dark-5 bg-dark-8 px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {#each rawLines as line (line.id)}
          <div class="whitespace-pre-wrap break-all text-dark-2">{line.text}</div>
        {/each}
      </div>
    </details>
  </div>
</div>
