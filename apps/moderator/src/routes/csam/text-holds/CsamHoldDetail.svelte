<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
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
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import FactRow from '$lib/components/minor-flags/FactRow.svelte';
  import PreviewImagesCard from '$lib/components/minor-flags/PreviewImagesCard.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import HighlightedText from '$lib/components/restrictions/HighlightedText.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import { imageReveal } from '$lib/csam-holds/image-reveal.svelte';
  import { csamReportUrl, entityUrl, userLookupUrl } from '$lib/entity-url';
  import { LINK_BUTTON, LINK_CLASS, dateTime, plural, shortAge } from '$lib/format';
    import type { Outcome } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import HoldAuthorCard from './HoldAuthorCard.svelte';
  import HoldConversation from './HoldConversation.svelte';
  import HoldParentCard from './HoldParentCard.svelte';
  import HoldProfileCard from './HoldProfileCard.svelte';
  import {
    alsoDecidable,
    ALSO_MAX,
    fetchHoldAuthor,
    forgetHoldAuthors,
    type AlsoResult,
    type HoldAuthor,
  } from './hold-author';
  import { parentUrlType, type CsamHoldView } from './hold-context';
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
    onothers,
  }: {
    row: CsamHoldView;
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
    /** What the decision did to the author's other holds, when it was applied to them as well. */
    onothers: (decision: string, results: AlsoResult[]) => void;
  } = $props();

  const entityHref = $derived(holdEntityHref(civitaiUrl, row));
  const parentHref = $derived(
    row.parent ? entityUrl(civitaiUrl, parentUrlType(row.parent.type), row.parent.id) : null
  );
  const canRemove = $derived(canRemoveHeld(row.entityType));
  const decidedRow = $derived(row.status !== 'Pending');
  const dismissedRow = $derived(row.status === 'Dismissed');
  const enabled = $derived(holdDecisionEnabled(row, { canDecide, canStrike, canBan }));
  const phrases = $derived(quotedPhrases(row.reason));
  const typeName = $derived(entityLabel(row.entityType));
  // Searching the entity id lists every hold it has had, so the earlier ruling is on the page the link opens.
  const holdHref = (holdId: number) =>
    urlWith(page.url, {
      hold: holdId,
      status: 'all',
      entityType: row.entityType,
      q: row.entityId,
      author: null,
      page: null,
    });
  const priorHref = $derived(row.priorHoldId === null ? null : holdHref(row.priorHoldId));

  let formEl: HTMLFormElement | undefined = $state();
  let decision = $state<CsamHoldDecision>('dismiss');
  let confirming = $state<CsamHoldDecision | null>(null);
  let confirmOpen = $state(false);

  // Which other holds a decision can cover. The shell remounts this component per hold, so the request
  // and the checkbox start fresh; the counts are read from the settled request when a button is pressed.
  let authorAttempt = $state(0);
  // Client only: a relative fetch during server rendering throws, and the shell hydrates per hold anyway.
  const authorRequest = $derived.by(() => {
    void authorAttempt;
    return browser ? fetchHoldAuthor(row.id) : new Promise<never>(() => {});
  });
  let applyToAuthor = $state(false);

  type Coverage = {
    /** What the decision is applied to: the first `ALSO_MAX` of `eligible`. */
    also: { holdId: number; textHash: string }[];
    eligible: number;
    pending: number;
  };
  const NO_COVERAGE: Coverage = { also: [], eligible: 0, pending: 0 };
  const pendingOf = (loaded: HoldAuthor) => loaded.holds.others.filter((h) => h.status === 'Pending');
  const eligibleFor = (loaded: HoldAuthor, next: CsamHoldDecision) =>
    alsoDecidable(pendingOf(loaded), next, canRemoveHeld);
  const coverageFor = async (next: CsamHoldDecision): Promise<Coverage> => {
    if (!applyToAuthor) return NO_COVERAGE;
    const loaded = await authorRequest.catch(() => null);
    if (!loaded) return NO_COVERAGE;
    const eligible = eligibleFor(loaded, next);
    return {
      also: eligible.slice(0, ALSO_MAX),
      eligible: eligible.length,
      pending: pendingOf(loaded).length,
    };
  };
  const coversNone = (coverage: Coverage) =>
    applyToAuthor && coverage.pending > 0 && !coverage.also.length;
  let also = $state<{ holdId: number; textHash: string }[]>([]);
  let coverage = $state<Coverage>(NO_COVERAGE);

  // One form and one note for every action; the hidden field carries which button was pressed.
  async function decide(next: CsamHoldDecision, covered: Coverage) {
    decision = next;
    also = covered.also;
    await tick();
    formEl?.requestSubmit();
  }

  const press = async (next: CsamHoldDecision) => {
    const covered = await coverageFor(next);
    if (CSAM_HOLD_CONFIRMS[next] || covered.also.length || coversNone(covered)) {
      coverage = covered;
      confirming = next;
      confirmOpen = true;
    } else void decide(next, covered);
  };

  const confirmAsk = (next: CsamHoldDecision, covered: Coverage) => {
    const base = CSAM_HOLD_CONFIRMS[next] ?? {
      label: next === 'dismiss' ? 'Dismiss all' : 'Remove all',
      title: next === 'dismiss' ? 'Dismiss these holds?' : 'Remove the content of these holds?',
      description:
        next === 'dismiss'
          ? 'The hold is closed and nothing changes on the content or the account.'
          : 'The content is taken down.',
    };
    const count = covered.also.length;
    if (coversNone(covered))
      return {
        ...(CSAM_HOLD_CONFIRMS[next] ?? { label: 'Continue', title: 'Decide only this hold?' }),
        description: `${base.description} None of the author’s other pending holds can take this decision, so they stay pending.`,
      };
    if (!count) return base;
    const skipped = covered.pending - covered.eligible;
    const capped = covered.eligible - count;
    const alone = next === 'remove_strike' || next === 'remove_ban' || next === 'remove_ban_report';
    return {
      ...base,
      description: `${base.description} The same is applied to ${
        capped ? `the first ${count} of ${covered.eligible} other pending holds` : plural(count, 'other pending hold')
      } by this author, without you opening them${
        alone ? ' (the strike or ban is applied once, with this hold)' : ''
      }. They are recorded as batch decisions, not as reviewed.${capped ? ` The other ${capped} stay pending: decide again for the next batch.` : ''}${
        skipped ? ` ${plural(skipped, 'hold')} cannot be removed from here and stay pending.` : ''
      }`,
    };
  };

  type KeyTone = 'red' | 'dark-red' | 'darker-red' | 'red-outline';
  const KEY_LOOK: Record<CsamHoldDecision, { label: string; tone?: KeyTone }> = {
    dismiss: { label: 'Dismiss' },
    remove: { label: 'Remove', tone: 'red' },
    remove_strike: { label: 'Remove + strike', tone: 'dark-red' },
    remove_ban: { label: 'Remove + ban', tone: 'darker-red' },
    remove_ban_report: { label: 'Ban + file NCMEC report', tone: 'red-outline' },
  };
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
      // Before the shell moves on, so it skips the holds just closed.
      if (opts.result.type === 'success') {
        forgetHoldAuthors();
        const others = (opts.result.data as { others?: AlsoResult[] } | undefined)?.others;
        if (others) onothers(String(input.formData.get('decision')), others);
      }
      await finish?.(opts);
      if (opts.result.type === 'success' && reportUserId !== null)
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
        {#if row.textUpdatedAt && !decidedRow}
          <MetaChip tone="amber">text updated {shortAge(row.textUpdatedAt)} ago</MetaChip>
        {/if}
        {#if row.redetected}<MetaChip tone="amber">re-detected</MetaChip>{/if}
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

    {#if row.coverImages.length}
      <TriageCard dense title={row.entityType === 'Model' ? 'Model media' : 'Post media'}>
        <PreviewImagesCard
          images={row.coverImages}
          total={row.imageTotal}
          blurred={!imageReveal.on}
          allHref={entityHref ?? undefined}
        />
      </TriageCard>
    {/if}

    <div class="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <TriageCard dense title="Why it was held">
        <p class="m-0 text-[15px] leading-normal text-white">{row.reason}</p>
        {#if row.redetected && priorHref}
          <p class="m-0 mt-2 text-[13px] text-dark-0">
            {row.priorStatus === 'Confirmed' ? 'Removed' : 'Dismissed'} before{row.priorDecidedByUsername
              ? ` by ${row.priorDecidedByUsername}`
              : ''}{row.priorDecidedAt ? ` ${shortAge(row.priorDecidedAt)} ago` : ''}, then the text
            changed and was held again.
            <a href={priorHref} class={LINK_CLASS}>See that hold</a>
          </p>
        {/if}
        {#if row.cleanRescanAt && !decidedRow}
          <p class="m-0 mt-2 text-[13px] text-dark-0">
            <MetaChip tone="green">edited since</MetaChip>
            The latest scan of this {typeName.toLowerCase()} is clean ({shortAge(row.cleanRescanAt)} ago); the
            text held here may no longer be on it. The hold stays open until you decide.
          </p>
        {/if}
        {#if row.ruledBefore}
          <p class="m-0 mt-2 text-[13px] text-dark-0">
            This text was ruled on before: {row.ruledBefore.status === 'Confirmed'
              ? 'removed'
              : 'dismissed'}.
            <a href={holdHref(row.ruledBefore.holdId)} class={LINK_CLASS}>See that hold</a>
          </p>
        {/if}
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
        {#if row.earlierTexts.length}
          <details class="mt-3 text-[13px] text-dark-0">
            <summary class="cursor-pointer text-dark-1">
              Earlier held text ({row.earlierTexts.length})
            </summary>
            {#each row.earlierTexts as earlier, i (i)}
              <div class="mt-2 border-l border-dark-4 pl-3">
                {#if earlier.at}<p class="m-0 text-[11px] text-dark-2">
                    replaced {shortAge(earlier.at)} ago
                  </p>{/if}
                <p class="m-0 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                  {earlier.text}
                </p>
              </div>
            {/each}
          </details>
        {/if}
      </TriageCard>
    </div>

    {#if row.profile}
      <HoldProfileCard profile={row.profile} blurred={!imageReveal.on} />
    {/if}

    {#if row.parent}
      <HoldParentCard parent={row.parent} href={parentHref} blurred={!imageReveal.on} />
    {/if}

    {#if row.chatId !== null}
      <HoldConversation holdId={row.id} chatId={row.chatId} />
    {/if}

    {#if row.userId !== null}
      <HoldAuthorCard request={authorRequest} holdId={row.id} onretry={() => authorAttempt++} />
    {/if}

    <TriageCard dense title="Details">
      <dl class="m-0 space-y-1.5">
        <FactRow label="Held">{dateTime(row.createdAt)}</FactRow>
        {#if row.textUpdatedAt}
          <FactRow label="Text updated">{dateTime(row.textUpdatedAt)}</FactRow>
        {/if}
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
        <input type="hidden" name="textHash" value={row.textHash} />
        <input type="hidden" name="decision" value={decision} />
        {#if also.length}<input type="hidden" name="also" value={JSON.stringify(also)} />{/if}
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
            {#await authorRequest then loaded}
              {@const pending = pendingOf(loaded)}
              {#if pending.length}
                {@const dismissCount = eligibleFor(loaded, 'dismiss').length}
                {@const removeCount = eligibleFor(loaded, 'remove').length}
                <div class="flex shrink-0 items-center gap-2 text-[13px] text-dark-0">
                  <Checkbox
                    id="apply-to-author"
                    bind:checked={applyToAuthor}
                    disabled={!dismissCount && !removeCount}
                  />
                  <label for="apply-to-author">
                    {#if dismissCount || removeCount}
                      Also apply to this author’s other pending holds (dismiss: {dismissCount}, remove: {removeCount}{dismissCount > ALSO_MAX || removeCount > ALSO_MAX
                        ? `; ${ALSO_MAX} at a time`
                        : ''})
                    {:else}
                      None of this author’s {plural(pending.length, 'other pending hold')} can take a decision from here
                    {/if}
                  </label>
                </div>
              {/if}
            {/await}
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
      <AlertDialog.Root bind:open={confirmOpen}>
        <AlertDialog.Content>
          {#if confirming}
            {@const ask = confirmAsk(confirming, coverage)}
            <AlertDialog.Header>
              <AlertDialog.Title>{ask.title}</AlertDialog.Title>
              <AlertDialog.Description>{ask.description}</AlertDialog.Description>
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
              <AlertDialog.Action
                variant="destructive"
                onclick={() => {
                  confirmOpen = false;
                  void decide(confirming!, coverage);
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
