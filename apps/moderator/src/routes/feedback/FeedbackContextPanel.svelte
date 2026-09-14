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
     * 🔴 The row's `Feedback.area`. Load-bearing, not decoration: the `browsingLevel` decode is
     * guarded on `(area, key)`, because a key means whatever the surface that wrote it meant. See
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
        <!-- 🔴 Formatted on `(area, key)`, never by key alone. `browsingLevel` is a BITMASK on
             `bitdex-image-feed` — `28` means "R, X, XXX", not level 28 — and means nothing at all
             anywhere else. A global key match would relabel a future area's identically-named value
             as a content rating. Every other pair keeps the rendering it has always had. -->
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

<!-- 🔴 EVERYTHING BELOW IS REPORTER-SUPPLIED TEXT AND IS RENDERED AS TEXT, FULL STOP. No `href`,
     no `<img src>`, no `EdgeImage`, nothing that turns a stored string into a request. The
     precedent is live and in this directory: `$lib/feedback.ts`'s `IMAGE_KEY` exists because
     `getEdgeUrl` returns any `http`-prefixed argument VERBATIM, so an unfiltered id becomes an
     outbound request from a moderator's browser and hands the reporter a read receipt naming who
     opened their report and when. `networkErrors[].url` is exactly that shape of value — a
     client-supplied string that LOOKS like it wants to be a link. It must not become one.
     Svelte escapes interpolated text, so the same strings are inert as content.
     Pinned by `feedback-panel-tripwires.test.ts`. -->
{#if context.consoleErrors.length}
  <section class="flex min-w-0 flex-col gap-2">
    <h3 class="text-xs tracking-wide text-dark-2 uppercase">
      Console errors
      <span class="ml-2 font-normal normal-case">
        last {context.consoleErrors.length}, oldest first
      </span>
    </h3>
    <ol class="flex min-w-0 flex-col gap-1">
      {#each context.consoleErrors as line, i (i)}
        <!-- Keyed by INDEX, for the reason `FeedbackAttachments.svelte` is: the array is
             client-supplied with no uniqueness constraint, and `{#each … (line)}` THROWS on a
             duplicate key in production as well as in dev. The same error twice in a row is the
             ORDINARY case for a console, so a value key would make a loop-erroring report
             permanently unopenable. -->
        <li class="rounded border border-dark-4 bg-dark-7 p-2 font-mono text-xs wrap-anywhere">
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
      <span class="ml-2 font-normal normal-case">
        last {context.networkErrors.length}, oldest first
      </span>
    </h3>
    <ul class="flex min-w-0 flex-col gap-1">
      {#each context.networkErrors as entry, i (i)}
        <li class="flex min-w-0 items-baseline gap-2 font-mono text-xs">
          <span class="shrink-0 text-red-400">{entry.status}</span>
          <span class="shrink-0 text-dark-2">{entry.initiatorType}</span>
          <!-- Query strings are stripped by the producer before storage, so this is a bare
               origin + path. It is still text, not a link — see the block comment above. -->
          <span class="min-w-0 wrap-anywhere">{entry.url}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

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
