<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import {
    FARO_LOKI_RETENTION_HOURS,
    faroSessionLink,
    reconstructFeedbackUrl,
    type FeedbackContext,
  } from '$lib/feedback';
  import { formatFeedbackFilterValue } from '$lib/feedback-filters';

  let {
    area,
    context,
    createdAt,
    civitaiUrl,
    grafanaUrl,
  }: {
    /**
     * 🔴 The row's `Feedback.area`. Load-bearing, not decoration: filter values are formatted per
     * `(area, key)`, because a key means whatever the surface that wrote it meant. See
     * `$lib/feedback-filters.ts`.
     */
    area: string;
    context: FeedbackContext;
    createdAt: Date | string;
    civitaiUrl: string;
    grafanaUrl: string | null;
  } = $props();

  const reconstructed = $derived(reconstructFeedbackUrl(context.path, context.filters));
  const faroHref = $derived(
    faroSessionLink({
      grafanaUrl,
      sessionId: context.sessionId,
      createdAt,
      now: Date.now(),
    })
  );

  let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  // The label is transient, so the timer is the one thing here that lives outside Svelte: cleared
  // on a re-click and on unmount, or it fires against a destroyed component.
  $effect(() => () => {
    if (copyTimer) clearTimeout(copyTimer);
  });

  async function copySession() {
    if (!context.sessionId) return;
    if (copyTimer) clearTimeout(copyTimer);
    // `writeText` rejects outside a secure context and when the permission is refused. An
    // unhandled rejection here would leave the button looking like it did nothing.
    try {
      await navigator.clipboard.writeText(context.sessionId);
      copyState = 'copied';
    } catch {
      copyState = 'failed';
    }
    copyTimer = setTimeout(() => (copyState = 'idle'), 2000);
  }
</script>

<section class="flex min-w-0 flex-col gap-2">
  <h3 class="text-xs tracking-wide text-dark-2 uppercase">
    Where the reporter said they were
    <span class="ml-2 font-normal normal-case">{dateTime(createdAt)}</span>
  </h3>

  {#if reconstructed}
    <a
      href={`${civitaiUrl}${reconstructed}`}
      target="_blank"
      rel="noreferrer"
      class={`${LINK_CLASS} font-mono text-sm wrap-anywhere`}
    >
      {reconstructed}
    </a>
  {:else}
    <p class="text-sm text-dark-2">No path reported.</p>
  {/if}

  {#if context.filters}
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
      {#each Object.entries(context.filters) as [key, value] (key)}
        <!-- 🔴 Formatted per `(area, key)`, never by key alone. `browsingLevel` is a BITMASK on
             `bitdex-image-feed` — `28` means "R, X, XXX", not level 28 — and means nothing at all
             anywhere else. A global key match would relabel a future area's identically-named value
             as a content rating. Unregistered keys keep the rendering they have always had. -->
        {@const formatted = formatFeedbackFilterValue(area, key, value)}
        <dt class="text-dark-2">{key}</dt>
        <dd class="font-mono wrap-anywhere" title={formatted.title ?? undefined}>
          {formatted.text}
        </dd>
      {/each}
    </dl>
  {/if}

  <div class="flex flex-wrap items-center gap-2 text-sm">
    <span class="text-dark-2">Session</span>
    {#if context.sessionId}
      <code class="font-mono wrap-anywhere">{context.sessionId}</code>
      <Button size="sm" variant="ghost" onclick={copySession}>
        {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
      </Button>
      <!-- 🔴 Expired data, a session that produced no telemetry, and an unconfigured link share one
           observable — an empty Explore pane. Each is named instead. -->
      {#if faroHref}
        <a href={faroHref} target="_blank" rel="noreferrer" class={LINK_CLASS}>Open in Grafana</a>
      {:else if !grafanaUrl}
        <span class="text-dark-2">No Grafana link — PUBLIC_GRAFANA_URL is not set.</span>
      {:else}
        <span class="text-dark-2">
          Faro session data for this report expired ({FARO_LOKI_RETENTION_HOURS} h Loki retention).
        </span>
      {/if}
    {:else}
      <span class="text-dark-2">
        None reported — ordinary, Faro does not run in dev, preview or an ad-blocked session.
      </span>
    {/if}
  </div>
</section>

{#if context.other}
  <section class="flex min-w-0 flex-col gap-2">
    <!-- 🔴 Dumped verbatim. `feedbackContextSchema` already accepts keys no current producer emits,
         and a panel rendering only the keys it knows about discards every future area's payload. -->
    <h3 class="text-xs tracking-wide text-dark-2 uppercase">Other context</h3>
    <pre class="max-h-64 overflow-auto rounded-lg border border-dark-4 bg-dark-7 p-3 text-xs">{JSON.stringify(
        context.other,
        null,
        2
      )}</pre>
  </section>
{/if}
