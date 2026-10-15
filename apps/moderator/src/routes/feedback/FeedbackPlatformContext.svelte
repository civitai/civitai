<script lang="ts">
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { feedbackReportHref } from '$lib/feedback-open';
  import type { PlatformFeedbackContext } from '$lib/feedback-platform';

  /**
   * An `apps-platform` row's context. Everything under "What the client reported" and "Samples" was
   * written by the reporting program: it is interpolated as text, never as markup and never as a
   * link — the one exception is `doc.href`, set only for a URL on the docs host itself.
   */
  let { context }: { context: PlatformFeedbackContext } = $props();
</script>

<section class="flex min-w-0 flex-col gap-2">
  <h3 class="text-xs tracking-wide text-dark-2 uppercase">What the client reported</h3>
  {#if context.report.length || context.doc}
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
      {#each context.report as entry (entry.key)}
        <dt class="text-dark-2">{entry.label}</dt>
        <dd class="font-mono whitespace-pre-wrap wrap-anywhere">{entry.text}</dd>
      {/each}
      {#if context.doc}
        <dt class="text-dark-2">Docs page</dt>
        <dd class="font-mono wrap-anywhere">
          {#if context.doc.href}
            <a href={context.doc.href} target="_blank" rel="noreferrer" class={LINK_CLASS}>
              {context.doc.text}
            </a>
          {:else}
            {context.doc.text}
          {/if}
        </dd>
      {/if}
    </dl>
  {:else}
    <p class="text-sm text-dark-2">No report fields.</p>
  {/if}
</section>

<section class="flex min-w-0 flex-col gap-2">
  <h3 class="text-xs tracking-wide text-dark-2 uppercase">Counted</h3>
  <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
    <dt class="text-dark-2">Reporters</dt>
    <dd class="tabular-nums">
      {context.reporters ?? '—'}
      {#if context.reporterIdCount !== null && context.reporterIdCount !== context.reporters}
        <span class="text-dark-2">({context.reporterIdCount} ids recorded)</span>
      {/if}
    </dd>
    <dt class="text-dark-2">Reports</dt>
    <dd class="tabular-nums">{context.reports ?? '—'}</dd>
    <dt class="text-dark-2">First seen</dt>
    <dd>{dateTime(context.firstSeenAt)}</dd>
    <dt class="text-dark-2">Last seen</dt>
    <dd>{dateTime(context.lastSeenAt)}</dd>
    {#if context.reopenOf !== null}
      <dt class="text-dark-2">Reopens</dt>
      <dd>
        <a href={feedbackReportHref(context.reopenOf)} class={LINK_CLASS}>#{context.reopenOf}</a>
        <span class="text-dark-2">— dismissed, then reported again by new reporters</span>
      </dd>
    {/if}
    {#if context.regressionOf !== null}
      <dt class="text-dark-2">Regression of</dt>
      <dd>
        <a href={feedbackReportHref(context.regressionOf)} class={LINK_CLASS}>
          #{context.regressionOf}
        </a>
        <span class="text-dark-2">— reported again from a version at or past its fix</span>
      </dd>
    {/if}
    {#if context.fingerprint}
      <dt class="text-dark-2">Fingerprint</dt>
      <dd class="font-mono text-xs wrap-anywhere">{context.fingerprint}</dd>
    {/if}
  </dl>
</section>

<section class="flex min-w-0 flex-col gap-2">
  <h3 class="text-xs tracking-wide text-dark-2 uppercase">What reporters read back</h3>
  {#if context.resolution}
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
      <dt class="text-dark-2">Fixed in</dt>
      <dd>
        {#if context.resolution.fixedIn?.version.trim()}
          {context.resolution.fixedIn.component} {context.resolution.fixedIn.version}
        {:else if context.resolution.fixedIn}
          <!-- The readback drops a fixed-in with no version, so reporters see none. -->
          — <span class="text-dark-2">({context.resolution.fixedIn.component} recorded, no version: reads
            back as addressed once actioned)</span>
        {:else}
          —
        {/if}
      </dd>
      <dt class="text-dark-2">Public note</dt>
      <dd class="whitespace-pre-wrap wrap-anywhere">{context.resolution.publicNote ?? '—'}</dd>
      <dt class="text-dark-2">Set</dt>
      <dd>
        {dateTime(context.resolution.at)}
        {#if context.resolution.byId !== null}
          <span class="text-dark-2">by #{context.resolution.byId}</span>
        {/if}
      </dd>
    </dl>
  {:else}
    <p class="text-sm text-dark-2">No resolution yet — reporters see only the status.</p>
  {/if}
</section>

{#if context.samples.length}
  <section class="flex min-w-0 flex-col gap-2">
    <h3 class="text-xs tracking-wide text-dark-2 uppercase">
      Samples from later reporters
      <span class="ml-2 font-normal normal-case">{context.samples.length}</span>
    </h3>
    <ul class="flex flex-col gap-2 text-sm">
      <!-- By index: the array is reporter-written with no uniqueness, and a duplicate key throws. -->
      {#each context.samples as sample, i (i)}
        <li class="rounded-lg border border-dark-4 bg-dark-7 p-3">
          <p class="whitespace-pre-wrap wrap-anywhere">{sample.text}</p>
          <p class="mt-1 text-xs text-dark-2">
            {sample.userId !== null ? `#${sample.userId}` : 'unknown user'}
            {#if sample.clientVersion}· client {sample.clientVersion}{/if}
          </p>
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#if context.other}
  <section class="flex min-w-0 flex-col gap-2">
    <!-- Dumped verbatim: whatever the parser did not recognise is shown, never dropped. -->
    <h3 class="text-xs tracking-wide text-dark-2 uppercase">Other context</h3>
    <pre class="max-h-64 overflow-auto rounded-lg border border-dark-4 bg-dark-7 p-3 text-xs">{JSON.stringify(
        context.other,
        null,
        2
      )}</pre>
  </section>
{/if}
