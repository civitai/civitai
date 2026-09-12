<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import {
    FARO_LOKI_RETENTION_HOURS,
    faroSessionLink,
    reconstructFeedbackUrl,
    type FeedbackContext,
  } from '$lib/feedback';

  /**
   * What the reporter's browser said, rendered as a claim rather than as evidence — the heading is
   * where they SAID they were.
   */
  let {
    context,
    createdAt,
    civitaiUrl,
    grafanaUrl,
  }: {
    context: FeedbackContext;
    createdAt: Date | string;
    civitaiUrl: string;
    grafanaUrl: string | null;
  } = $props();

  const reconstructed = $derived(reconstructFeedbackUrl(context.path, context.filters));
  // `now` is read once per render rather than inside the helper: a function that reads the clock
  // cannot be tested at the boundary it exists to enforce.
  const faroHref = $derived(
    faroSessionLink({
      grafanaUrl,
      sessionId: context.sessionId,
      createdAt,
      now: Date.now(),
    })
  );

  let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
  async function copySession() {
    if (!context.sessionId) return;
    // `writeText` rejects outside a secure context and when the permission is refused. An
    // unhandled rejection here would leave the button looking like it did nothing.
    try {
      await navigator.clipboard.writeText(context.sessionId);
      copyState = 'copied';
    } catch {
      copyState = 'failed';
    }
  }
</script>

<section class="flex flex-col gap-2">
  <h3 class="text-xs font-semibold tracking-wide text-dark-2 uppercase">
    Where the reporter said they were
    <span class="ml-2 font-normal normal-case">{dateTime(createdAt)}</span>
  </h3>

  {#if reconstructed}
    <!-- 🔴 `context.path` is a bare pathname. On a page whose whole view lives in the query string,
         linking `path` alone lands somewhere the report is not about. -->
    <a
      href={`${civitaiUrl}${reconstructed}`}
      target="_blank"
      rel="noreferrer"
      class={`${LINK_CLASS} font-mono text-sm`}
    >
      {reconstructed}
    </a>
  {:else}
    <p class="text-sm text-dark-2">No path reported.</p>
  {/if}

  {#if context.filters}
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
      {#each Object.entries(context.filters) as [key, value] (key)}
        <dt class="text-dark-2">{key}</dt>
        <!-- `none` is the marketplace builder's sentinel for "no category selected", written
             because an explicit `undefined` fails the context schema's value union. It is not a
             category called "none". -->
        <dd class="font-mono">{value === 'none' ? '(none)' : value === '' ? '—' : String(value)}</dd>
      {/each}
    </dl>
  {/if}

  <div class="flex flex-wrap items-center gap-2 text-sm">
    <span class="text-dark-2">Session</span>
    {#if context.sessionId}
      <code class="font-mono">{context.sessionId}</code>
      <Button size="sm" variant="ghost" onclick={copySession}>
        {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
      </Button>
      {#if faroHref}
        <a href={faroHref} target="_blank" rel="noreferrer" class={LINK_CLASS}>Open in Grafana</a>
      {:else if !grafanaUrl}
        <!-- 🔴 Three different facts share one observable — expired data, a session that produced
             no telemetry, and a link that was never configured. Each is named rather than shown as
             an empty Explore pane. -->
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

<section class="flex flex-col gap-2">
  <h3 class="text-xs font-semibold tracking-wide text-dark-2 uppercase">Attachments</h3>
  {#if context.images.length || context.screenshotId}
    <!-- 🔴 These are ids the CLIENT said it uploaded. Nothing proved the objects exist, that they
         belong to the reporter, or that a capture is of the page named in `path` — so a page
         capture can carry NSFW content or another user's UI, and the id is attacker-chosen.
         Accepted; row-level expansion is the containment (nothing loads until a row is opened).
         The one-line mitigation if this page ever reaches a non-moderator is `blur={40}` here plus
         a click to clear it. -->
    <div class="flex flex-wrap gap-3">
      {#each context.images as id (id)}
        <figure class="flex flex-col gap-1">
          <EdgeImage src={id} width={320} class="max-h-64 w-auto rounded-lg border border-dark-4" />
          <figcaption class="text-xs text-dark-2">Attached by the reporter</figcaption>
        </figure>
      {/each}
      {#if context.screenshotId}
        <figure class="flex flex-col gap-1">
          <EdgeImage
            src={context.screenshotId}
            width={320}
            class="max-h-64 w-auto rounded-lg border border-dark-4"
          />
          <figcaption class="text-xs text-dark-2">Opt-in capture of their own viewport</figcaption>
        </figure>
      {/if}
    </div>
  {:else}
    <p class="text-sm text-dark-2">(none)</p>
  {/if}
</section>

{#if context.other}
  <section class="flex flex-col gap-2">
    <!-- 🔴 Dumped verbatim. `feedbackContextSchema` already accepts keys no current producer emits,
         and a panel rendering only the keys it knows about discards every future area's payload. -->
    <h3 class="text-xs font-semibold tracking-wide text-dark-2 uppercase">Other context</h3>
    <pre class="max-h-64 overflow-auto rounded-lg border border-dark-4 bg-dark-7 p-3 text-xs">{JSON.stringify(
        context.other,
        null,
        2
      )}</pre>
  </section>
{/if}
