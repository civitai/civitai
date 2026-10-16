<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import { csamReportUrl, userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { CsamHoldRow } from '$lib/server/csam-holds.service';
  import type { Outcome } from '$lib/triage/queue';
  import { NOTE_MAX_LENGTH, entityLabel, holdEntityHref } from './hold-entity';

  let {
    row,
    civitaiUrl,
    canDismiss,
    verdict,
    error,
    submit,
    actionHref,
  }: {
    row: CsamHoldRow;
    civitaiUrl: string;
    canDismiss: boolean;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
  } = $props();

  const entityHref = $derived(holdEntityHref(civitaiUrl, row));
</script>

<TriageDetailFrame {verdict} {error}>
  {#snippet children()}
    <header class="space-y-2">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Badge variant="secondary" class="h-6 px-2.5 text-sm">{entityLabel(row.entityType)}</Badge>
        {#if entityHref}
          <a href={entityHref} target="_blank" rel="noreferrer" class="text-lg font-semibold {LINK_CLASS}">
            #{row.entityId} ↗<span class="sr-only"> (opens in new tab)</span>
          </a>
        {:else}
          <code class="text-lg text-dark-0">#{row.entityId}</code>
        {/if}
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-dark-2">
        <span>
          by
          {#if row.userId}
            <a href={userLookupUrl(row.userId)} class={LINK_CLASS}>
              {row.username ?? `user #${row.userId}`}
            </a>
          {:else}
            an unknown author
          {/if}
        </span>
        {#if row.userId}
          <a href={csamReportUrl(civitaiUrl, row.userId)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
            File CSAM report ↗<span class="sr-only"> (opens in new tab)</span>
          </a>
        {/if}
      </div>
    </header>

    <TriageCard title="Held text">
      <!-- Focusable so a keyboard user can scroll the text (WCAG 2.1.1). -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre
        tabindex="0"
        role="region"
        aria-label="Held text"
        class="m-0 max-h-96 overflow-y-auto font-sans text-sm whitespace-pre-wrap break-words text-dark-2">{row.text}</pre>
    </TriageCard>

    <TriageCard title="Why it was held">
      <p class="m-0 text-sm text-dark-0">{row.reason}</p>
    </TriageCard>

    <TriageCard title="Details">
      <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt class="text-dark-2">Held</dt>
        <dd class="m-0 text-dark-0">{dateTime(row.createdAt)}</dd>
        <dt class="text-dark-2">Content from</dt>
        <dd class="m-0 text-dark-0">{dateTime(row.contentAt)}</dd>
        <dt class="text-dark-2">Prompt</dt>
        <dd class="m-0 text-dark-0">{row.promptId ?? '—'}</dd>
        <dt class="text-dark-2">Workflow</dt>
        <dd class="m-0 font-mono text-dark-0 break-all">{row.workflowId ?? '—'}</dd>
      </dl>
    </TriageCard>
  {/snippet}
  {#snippet actions()}
    {#if canDismiss}
      <form
        method="POST"
        action={actionHref('dismiss')}
        data-triage-action="dismiss"
        use:enhance={submit('Dismissed')}
        class="flex flex-1 flex-wrap items-end gap-3"
      >
        <input type="hidden" name="holdId" value={row.id} />
        <Textarea
          name="note"
          rows={1}
          maxlength={NOTE_MAX_LENGTH}
          placeholder="Note (optional)"
          aria-label="Dismissal note"
          class="min-w-60 flex-1"
        />
        <Button type="submit" size="lg">Dismiss <kbd class="ml-1 text-xs text-dark-2">1</kbd></Button>
      </form>
    {:else}
      <p class="m-0 text-sm text-dark-2">Deciding a hold needs the “File a CSAM report” permission.</p>
    {/if}
  {/snippet}
</TriageDetailFrame>
