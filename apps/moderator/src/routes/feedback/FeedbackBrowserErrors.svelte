<script lang="ts">
  import type { FeedbackContext } from '$lib/feedback';

  let { context }: { context: FeedbackContext } = $props();
</script>

<!-- 🔴 Reporter-supplied text: render as text only. No `href`, `src` or `EdgeImage` in this file —
     `getEdgeUrl` returns an `http`-prefixed argument verbatim, which is why `IMAGE_KEY` exists in
     `$lib/feedback.ts`, and `networkErrors[].url` is that same shape of value. The ledger in
     `feedback-panel-tripwires.test.ts` counts request-making attributes across a NAMED FILE LIST;
     this file is on it, and a further split must add itself there or the guard passes on absence. -->
{#if context.consoleErrors.length}
  <section class="flex min-w-0 flex-col gap-2">
    <!-- "captured", not "last N": N is the stored array's length, not a cap, so a row holding 400
         and a row holding 10 would both have read "last 10" and the operator could not tell a
         complete snapshot from a tail. Ordering is a producer claim this app does not verify. -->
    <h3 class="text-xs tracking-wide text-dark-2 uppercase">
      Console errors
      <span class="ml-2 font-normal normal-case">{context.consoleErrors.length} captured</span>
    </h3>
    <ol class="flex max-h-64 min-w-0 flex-col gap-1 overflow-auto">
      <!-- Index key: the same console line repeating is the ordinary case, and a duplicate value
           key THROWS in production, making that report permanently unopenable. -->
      {#each context.consoleErrors as line, i (i)}
        <li class="rounded-lg border border-dark-4 bg-dark-7 p-2 font-mono text-xs wrap-anywhere">
          {line}
        </li>
      {/each}
    </ol>
  </section>
{/if}

{#if context.networkErrors.length}
  <section class="flex min-w-0 flex-col gap-2">
    <h3 class="text-xs tracking-wide text-dark-2 uppercase">
      Failed requests
      <span class="ml-2 font-normal normal-case">{context.networkErrors.length} captured</span>
    </h3>
    <ul class="flex max-h-64 min-w-0 flex-col gap-1 overflow-auto">
      <!-- Index key: same reason as the console list above. -->
      {#each context.networkErrors as entry, i (i)}
        <li class="flex min-w-0 items-baseline gap-2 font-mono text-xs">
          <!-- Red only for a real 4xx/5xx. The read side deliberately does not re-impose the
               producer's `400..599` bound, so a row stored under a future widened bound can carry a
               status-0 — an opaque cross-origin SUCCESS as often as a failure. Colouring that red
               under a "Failed requests" heading would assert something untrue. `text-red-400` is
               this app's severity-ramp red (`$lib/queue-thresholds.ts`), not an arbitrary literal. -->
          <span
            class={entry.status >= 400 && entry.status <= 599
              ? 'shrink-0 text-red-400'
              : 'shrink-0 text-dark-2'}>{entry.status}</span
          >
          <span class="shrink-0 text-dark-2">{entry.initiatorType}</span>
          <span class="min-w-0 wrap-anywhere">{entry.url}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}
