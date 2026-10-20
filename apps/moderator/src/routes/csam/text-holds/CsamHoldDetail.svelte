<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { tick } from 'svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import { csamReportUrl, userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { CsamHoldRow } from '$lib/server/csam-holds.service';
  import type { Outcome } from '$lib/triage/queue';
  import {
    CSAM_HOLD_OUTCOMES,
    NOTE_MAX_LENGTH,
    canRemoveHeld,
    decisionLabel,
    entityLabel,
    holdEntityHref,
    type CsamHoldDecision,
  } from './hold-entity';

  let {
    row,
    civitaiUrl,
    canDecide,
    canStrike,
    canBan,
    verdict,
    error,
    submit,
    actionHref,
  }: {
    row: CsamHoldRow;
    civitaiUrl: string;
    /** Holds `csam.report.file`: the page itself is closed to anyone else. */
    canDecide: boolean;
    /** Holds `user.strike`. */
    canStrike: boolean;
    /** Holds `user.ban`. */
    canBan: boolean;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
  } = $props();

  const entityHref = $derived(holdEntityHref(civitaiUrl, row));
  const canRemove = $derived(canRemoveHeld(row.entityType));
  const hasAuthor = $derived(row.userId !== null);
  // A decided hold opens read-only; the main app refuses a second decision either way.
  const decidedRow = $derived(row.status !== 'Pending');

  let formEl: HTMLFormElement | undefined = $state();
  let decision = $state<CsamHoldDecision>('dismiss');

  // One form and one note for every action; the hidden field carries which button was pressed.
  async function decide(next: CsamHoldDecision) {
    decision = next;
    await tick();
    formEl?.requestSubmit();
  }

  const outcome = (data: FormData) =>
    CSAM_HOLD_OUTCOMES[data.get('decision') as CsamHoldDecision] ?? 'Decided';

  // The existing CSAM report form is where an NCMEC report is filed; open it for the author once the
  // removal and ban have landed. A blocked pop-up leaves the "File CSAM report" link in the header.
  const decided: SubmitFunction = (input) => {
    const reportUserId = input.formData.get('decision') === 'remove_ban_report' ? row.userId : null;
    const inner = submit(outcome)(input);
    return async (opts) => {
      const finish = await inner;
      await finish?.(opts);
      if (reportUserId !== null && opts.result.type === 'success')
        window.open(csamReportUrl(civitaiUrl, reportUserId), '_blank', 'noopener');
    };
  };
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

    {#if decidedRow}
      <TriageCard title="Decision">
        <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt class="text-dark-2">Decided</dt>
          <dd class="m-0 text-dark-0">{decisionLabel(row)}</dd>
          <dt class="text-dark-2">By</dt>
          <dd class="m-0 text-dark-0">{row.decidedByUsername ?? 'an unknown moderator'}</dd>
          <dt class="text-dark-2">When</dt>
          <dd class="m-0 text-dark-0">{dateTime(row.decidedAt)}</dd>
          <dt class="text-dark-2">Note</dt>
          <dd class="m-0 text-dark-0 whitespace-pre-wrap break-words">{row.decisionNote ?? '—'}</dd>
        </dl>
      </TriageCard>
    {/if}

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
    {#if decidedRow}
      <p class="m-0 text-sm text-dark-2">This hold is already decided.</p>
    {:else if canDecide}
      <form
        bind:this={formEl}
        method="POST"
        action={actionHref('decide')}
        use:enhance={decided}
        class="flex flex-1 flex-wrap items-end gap-3"
      >
        <input type="hidden" name="holdId" value={row.id} />
        <input type="hidden" name="decision" value={decision} />
        <Textarea
          name="note"
          rows={1}
          maxlength={NOTE_MAX_LENGTH}
          placeholder="Note (optional)"
          aria-label="Decision note"
          class="min-w-60 flex-1"
        />
        <div class="flex flex-wrap items-center gap-2">
          {#if canRemove}
            <Button type="button" size="lg" onclick={() => decide('remove')}>Remove content</Button>
            {#if canStrike && hasAuthor}
              <ConfirmButton
                size="lg"
                label="Remove content + strike"
                title="Remove the content and strike the author?"
                description="The content is taken down and the author receives a strike and a notification."
                onconfirm={() => decide('remove_strike')}
              />
            {/if}
            {#if canBan && hasAuthor}
              <ConfirmButton
                size="lg"
                label="Remove content + ban"
                title="Remove the content and ban the author?"
                description="The content is taken down and the account is banned, which also removes its other content."
                onconfirm={() => decide('remove_ban')}
              />
              <ConfirmButton
                size="lg"
                label="Remove content + ban + NCMEC report"
                title="Remove, ban and file an NCMEC report?"
                description="The content is taken down and the account is banned. The CSAM report form then opens for the author so you can file the report."
                onconfirm={() => decide('remove_ban_report')}
              />
            {/if}
          {/if}
          <Button type="button" size="lg" variant="outline" onclick={() => decide('dismiss')}>
            Do nothing
          </Button>
        </div>
        {#if !canRemove}
          <p class="m-0 basis-full text-sm text-dark-2">
            A {entityLabel(row.entityType).toLowerCase()} cannot be removed from here yet. Remove it by
            hand, or choose "Do nothing".
          </p>
        {:else if !canStrike || !canBan}
          <p class="m-0 basis-full text-sm text-dark-2">
            {#if !canStrike}Striking needs the “Strike or notify an account” permission. {/if}
            {#if !canBan}Banning needs the “Ban or unban an account” permission.{/if}
          </p>
        {/if}
      </form>
    {:else}
      <p class="m-0 text-sm text-dark-2">Deciding a hold needs the “File a CSAM report” permission.</p>
    {/if}
  {/snippet}
</TriageDetailFrame>
