<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { tick } from 'svelte';
  import {
    IconExternalLink,
    IconFileAlert,
    IconLock,
    IconShield,
    IconUser,
  } from '@tabler/icons-svelte';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import FactRow from '$lib/components/minor-flags/FactRow.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import HighlightedText from '$lib/components/restrictions/HighlightedText.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import { csamReportUrl, userLookupUrl } from '$lib/entity-url';
  import { dateTime, shortAge } from '$lib/format';
  import type { CsamHoldRow } from '$lib/server/csam-holds.service';
  import type { Outcome } from '$lib/triage/queue';
  import {
    CSAM_HOLD_CONFIRMS,
    CSAM_HOLD_KEY_ORDER,
    CSAM_HOLD_OUTCOMES,
    NOTE_MAX_LENGTH,
    canRemoveHeld,
    decisionLabel,
    entityLabel,
    holdDecisionEnabled,
    holdEntityHref,
    holdTitle,
    quotedPhrases,
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
  // A decided hold opens read-only; the main app refuses a second decision either way.
  const decidedRow = $derived(row.status !== 'Pending');
  const dismissedRow = $derived(row.status === 'Dismissed');
  const enabled = $derived(holdDecisionEnabled(row, { canDecide, canStrike, canBan }));
  const phrases = $derived(quotedPhrases(row.reason));
  const typeName = $derived(entityLabel(row.entityType));

  const LINK_BUTTON =
    'h-[27px] gap-1.5 border-dark-4 bg-transparent px-2.5 text-xs font-normal text-dark-0 shadow-none dark:bg-transparent [&_svg]:size-[13px] [&_svg]:text-dark-1';

  let formEl: HTMLFormElement | undefined = $state();
  let decision = $state<CsamHoldDecision>('dismiss');
  let confirming = $state<CsamHoldDecision | null>(null);

  // One form and one note for every action; the hidden field carries which button was pressed.
  async function decide(next: CsamHoldDecision) {
    decision = next;
    await tick();
    formEl?.requestSubmit();
  }

  // A decision that takes the account or its content down asks first.
  const press = (next: CsamHoldDecision) => {
    if (CSAM_HOLD_CONFIRMS[next]) confirming = next;
    else void decide(next);
  };

  type KeyTone = 'red' | 'dark-red' | 'darker-red' | 'red-outline';
  const KEY_LOOK: Record<CsamHoldDecision, { label: string; tone?: KeyTone }> = {
    dismiss: { label: 'Dismiss' },
    remove: { label: 'Remove', tone: 'red' },
    remove_strike: { label: 'Remove + strike', tone: 'dark-red' },
    remove_ban: { label: 'Remove + ban', tone: 'darker-red' },
    remove_ban_report: { label: 'Ban + file NCMEC report', tone: 'red-outline' },
  };
  // Digit n + 1 picks the n-th, in the order `holdDecisionEnabled` reports.
  const KEYS = CSAM_HOLD_KEY_ORDER.map((decision) => ({ decision, ...KEY_LOOK[decision] }));

  const whyDisabled = (key: CsamHoldDecision) => {
    if (!canRemove && key !== 'dismiss') return `A ${typeName.toLowerCase()} cannot be removed from here yet.`;
    if (key === 'remove_strike' && !canStrike)
      return 'Striking needs the “Strike or notify an account” permission.';
    if ((key === 'remove_ban' || key === 'remove_ban_report') && !canBan)
      return 'Banning needs the “Ban or unban an account” permission.';
    if (row.userId === null && key !== 'dismiss' && key !== 'remove')
      return 'The author of this hold is unknown.';
    return undefined;
  };

  const outcome = (data: FormData) =>
    CSAM_HOLD_OUTCOMES[data.get('decision') as CsamHoldDecision] ?? 'Decided';

  // The existing CSAM report form is where an NCMEC report is filed; open it for the author once the
  // removal and ban have landed. A blocked pop-up leaves the "File CSAM report" button in the header.
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
    <TriageDetailHeader
      title={holdTitle(row)}
      reference={`${typeName} #${row.entityId}`}
      linksBeside
    >
      {#snippet chips()}
        <MetaChip>{typeName}</MetaChip>
        <MetaChip>held {shortAge(row.createdAt)} ago</MetaChip>
        {#if !decidedRow && row.live}
          <MetaChip tone="amber">still live</MetaChip>
        {:else if decidedRow}
          <MetaChip tone={dismissedRow ? 'neutral' : 'red'}>
            {dismissedRow ? 'dismissed' : 'removed'}
            {row.decidedAt ? `${shortAge(row.decidedAt)} ago` : ''}
          </MetaChip>
        {/if}
      {/snippet}
      {#snippet links()}
        {#if entityHref}
          <Button
            variant="outline"
            size="sm"
            class={LINK_BUTTON}
            href={entityHref}
            target="_blank"
            rel="noreferrer"
          >
            <IconExternalLink aria-hidden="true" /> Open {typeName.toLowerCase()}
          </Button>
        {/if}
        {#if row.userId}
          <Button variant="outline" size="sm" class={LINK_BUTTON} href={userLookupUrl(row.userId)}>
            <IconUser aria-hidden="true" />
            {row.username ? `Author: ${row.username}` : 'Author'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            class={LINK_BUTTON}
            href={csamReportUrl(civitaiUrl, row.userId)}
            target="_blank"
            rel="noreferrer"
          >
            <IconFileAlert aria-hidden="true" /> File CSAM report
          </Button>
        {/if}
      {/snippet}
    </TriageDetailHeader>

    {#if decidedRow}
      <TriageCard dense title="Decision" accent={dismissedRow ? 'neutral' : 'red'}>
        <dl class="m-0 space-y-1.5">
          <FactRow label="Outcome">{decisionLabel(row)}</FactRow>
          <FactRow label="By">{row.decidedByUsername ?? 'an unknown moderator'}</FactRow>
          <FactRow label="When">{dateTime(row.decidedAt)}</FactRow>
          <FactRow label="Note"
            ><span class="whitespace-pre-wrap break-words">{row.decisionNote ?? '—'}</span></FactRow
          >
        </dl>
      </TriageCard>
    {/if}

    <div class="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <TriageCard dense title="Why it was held">
        <p class="m-0 text-[15px] leading-normal text-white">{row.reason}</p>
        {#if row.promptId !== null}
          <p class="m-0 mt-2 text-[11px] text-dark-2">
            csam prompt v{row.promptId} · {shortAge(row.createdAt)} ago
          </p>
        {/if}
      </TriageCard>
      <TriageCard dense title="Scanned text">
        <!-- Focusable so a keyboard user can scroll the text (WCAG 2.1.1). -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          tabindex="0"
          role="region"
          aria-label="Scanned text"
          class="max-h-96 overflow-y-auto text-dark-0"
        >
          <HighlightedText text={row.text} highlight={phrases} />
        </div>
      </TriageCard>
    </div>

    <TriageCard dense title="Details">
      <dl class="m-0 space-y-1.5">
        <FactRow label="Held">{dateTime(row.createdAt)}</FactRow>
        <FactRow label="Content from">{dateTime(row.contentAt)}</FactRow>
        <FactRow label="Workflow"
          ><span class="font-mono break-all">{row.workflowId ?? '—'}</span></FactRow
        >
      </dl>
    </TriageCard>
  {/snippet}
  {#snippet actions()}
    {#if decidedRow}
      <p class="m-0 flex items-center gap-1.5 text-sm text-dark-2">
        <IconLock class="size-3.5" aria-hidden="true" /> This hold is already decided.
      </p>
    {:else if canDecide}
      <form
        bind:this={formEl}
        method="POST"
        action={actionHref('decide')}
        use:enhance={decided}
        class="min-w-0 flex-1"
      >
        <input type="hidden" name="holdId" value={row.id} />
        <input type="hidden" name="decision" value={decision} />
        <TriageDecisionBar
          hint="Dismiss closes the hold and changes nothing. 5 bans the author and opens the CSAM report form for them. The next hold opens after each decision; J/K to move."
        >
          {#snippet buttons()}
            {#each KEYS as k, i (k.decision)}
              {#if i === KEYS.length - 1}<span class="flex-1"></span>{/if}
              <TriageKeyButton
                type="button"
                key={i + 1}
                tone={k.tone}
                disabled={!enabled[i]}
                title={enabled[i] ? undefined : whyDisabled(k.decision)}
                onclick={() => press(k.decision)}
              >
                {#if k.tone === 'red-outline'}<IconShield class="size-3.5" aria-hidden="true" />{/if}
                {k.label}
              </TriageKeyButton>
            {/each}
          {/snippet}
          {#snippet fields()}
            <!-- Enter in the only text field would otherwise submit the form as a dismissal. -->
            <Input
              name="note"
              maxlength={NOTE_MAX_LENGTH}
              placeholder="Note for the record (optional)"
              aria-label="Decision note"
              class="h-8 min-w-0 flex-1 border-dark-4 bg-dark-7 text-[13px] dark:bg-dark-7"
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
            />
          {/snippet}
        </TriageDecisionBar>
      </form>
      <AlertDialog.Root
        bind:open={() => confirming !== null, (open) => !open && (confirming = null)}
      >
        <AlertDialog.Content>
          {#if confirming && CSAM_HOLD_CONFIRMS[confirming]}
            {@const ask = CSAM_HOLD_CONFIRMS[confirming]!}
            <AlertDialog.Header>
              <AlertDialog.Title>{ask.title}</AlertDialog.Title>
              <AlertDialog.Description>{ask.description}</AlertDialog.Description>
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
              <AlertDialog.Action
                variant="destructive"
                onclick={() => {
                  const chosen = confirming!;
                  confirming = null;
                  void decide(chosen);
                }}>{ask.label}</AlertDialog.Action
              >
            </AlertDialog.Footer>
          {/if}
        </AlertDialog.Content>
      </AlertDialog.Root>
    {:else}
      <p class="m-0 text-sm text-dark-2">Deciding a hold needs the “File a CSAM report” permission.</p>
    {/if}
  {/snippet}
</TriageDetailFrame>
