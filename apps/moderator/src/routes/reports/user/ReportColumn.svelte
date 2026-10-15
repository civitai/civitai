<script lang="ts">
  import { enhance } from '$app/forms';
  import ReportList from '$lib/components/report-queue/ReportList.svelte';
  import type { ReportListItem } from '$lib/components/report-queue/report-list';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { IconCheck } from '@tabler/icons-svelte';
  import BanConfirmForm from '$lib/components/BanConfirmForm.svelte';
  import { PROFILE_FIELDS } from '$lib/enforcement';
  import { MUTE_PRESETS } from '../../retool/user-lookup/enforcement-options';
  import CannedReasonPicker from '$lib/components/CannedReasonPicker.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { STRIKE_REASONS } from '$lib/moderation-reasons';
  import { dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';

  /**
   * The model queue's right-hand column, for an account: the report (what was said, by whom, and its
   * ruling) above what to do about the account. Each scrolls with the column, beside the evidence.
   */
  let {
    suspectId,
    reports,
    account,
    canAct,
    canBan,
    onReportSubmit,
    pendingId,
    reportError,
  }: {
    suspectId: number;
    /** The open account's reports: its open ones, and any the queue is showing (`reportsForItem`). */
    reports: ReportListItem[];
    /** Null when the account no longer exists — its reports can still be ruled on. */
    account: {
      username: string | null;
      bannedAt: Date | null;
      banReason: string | null;
      muted: boolean;
      /** Set when the mute lifts on its own. */
      mutedUntil: Date | null;
      profile: { bio: string | null; message: string | null; location: string | null } | null;
    } | null;
    canAct: boolean;
    canBan: boolean;
    onReportSubmit: SubmitFunction;
    pendingId: number | null;
    reportError: string | null;
  } = $props();

  // One form open at a time: two half-filled enforcement forms on one account invited submitting the
  // wrong one.
  let open = $state<'strike' | 'notify' | 'ban' | 'unban' | 'timedMute' | 'clear' | null>(null);
  let strikeReason = $state('');
  let muteHours = $state(24);
  const uid = $props.id();

  // Only the fields that hold text are offered: a tick beside an empty field clears nothing, and reads
  // as though it did.
  const filledFields = $derived(PROFILE_FIELDS.filter(([key]) => !!account?.profile?.[key]?.trim()));

  // One FormState per row, so a refusal shows in the row that was refused. Each holds its own result
  // rather than the page's `form`, which every panel would see.
  const rowForm = (after: () => void = () => {}) =>
    new FormState({
      reload: true,
      onSuccess: () => {
        open = null;
        after();
      },
    });
  const strikeForm = rowForm(() => (strikeReason = ''));
  const muteForm = rowForm(() => (muteHours = 24));
  const banForm = rowForm();
  const profileForm = rowForm();
  const notifyForm = rowForm();
  // One write at a time across the rows: each reloads the account, and two in flight raced to show it.
  const busy = $derived(
    [strikeForm, muteForm, banForm, profileForm, notifyForm].some((f) => f.submitting)
  );
</script>

<!-- 1. The reports: what was said, by whom, and the ruling on each. -->
<ReportList
  {reports}
  canRule={canAct}
  action="?/actionReport"
  onSubmit={onReportSubmit}
  busyId={pendingId}
  error={reportError}
>
  {#snippet empty()}
    <!-- Every report on the account is ruled on, or it was opened from a link (User Lookup, the
         dashboard) for an account with none open. -->
    <p class="m-0 text-sm text-muted-foreground">
      No open reports on this account.
      <a href={userLookupUrl(suspectId, 'reports')} class="link">All its reports in User Lookup</a>
    </p>
  {/snippet}
</ReportList>

{#snippet done(label: string)}
  <span class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-green-300">
    <IconCheck size={14} />
    {label}
  </span>
{/snippet}

<!-- What a row says, at the column's full width: its name with what is in force (the tick) on the
     right, then what it does. Controls go on their own line below — beside the text they squeezed
     the description to a sliver and cut their own labels off in a 26rem column. -->
{#snippet heading(title: string, description: string, doneLabel: string | null, muted = false)}
  <div>
    <div class="flex items-center justify-between gap-2">
      <p class="m-0 text-sm font-medium {muted ? 'text-muted-foreground' : ''}">{title}</p>
      {#if doneLabel}{@render done(doneLabel)}{/if}
    </div>
    <p class="m-0 text-xs text-muted-foreground">{description}</p>
  </div>
{/snippet}

<!-- 2. What to do about the account. Rows, as the model queue's "Act on the model": what each does,
     a tick for what is already in force, and its undo beside it. -->
{#if canAct && account}
  <section aria-labelledby="act-heading" class="flex flex-col gap-2">
    <h3 id="act-heading" class="m-0 text-sm font-semibold">Act on the account</h3>
    <div class="divide-y rounded-lg border">
      <!-- Strike -->
      <div class="flex flex-col gap-2 p-3">
        {@render heading('Strike', 'Records a strike with the reason the user is shown, and notifies them.', null)}
        {#if open === 'strike'}
          <form method="POST" action="?/strike" use:enhance={strikeForm.enhance} class="flex flex-col gap-2">
            <input type="hidden" name="userId" value={suspectId} />
            {#if strikeForm.error}<ErrorAlert message={strikeForm.error} />{/if}
            <CannedReasonPicker reasons={STRIKE_REASONS} idPrefix="strike" bind:value={strikeReason} />
            <div class="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="destructive" disabled={busy}>
                {strikeForm.submitting ? 'Working…' : 'Issue strike'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onclick={() => (open = null)}>Cancel</Button>
            </div>
          </form>
        {:else}
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onclick={() => (open = 'strike')}>Strike</Button>
          </div>
        {/if}
      </div>

      <!-- Mute: indefinite or timed. Unmute lifts either. -->
      <div class="flex flex-col gap-2 p-3">
        {@render heading(
          'Mute',
          account.muted
            ? account.mutedUntil
              ? `Muted until ${dateTime(account.mutedUntil)}, then lifts on its own.`
              : 'Muted until a moderator unmutes them.'
            : 'Stops the account posting, commenting and messaging. A mute lasts until a moderator lifts it; a timed mute lifts on its own.',
          account.muted ? 'Muted' : null
        )}
        {#if muteForm.error}<ErrorAlert message={muteForm.error} />{/if}
        {#if account.muted}
          <form method="POST" action="?/setMuted" use:enhance={muteForm.enhance} class="flex flex-wrap gap-2">
            <input type="hidden" name="userId" value={suspectId} />
            <input type="hidden" name="muted" value="false" />
            <Button type="submit" size="sm" variant="outline" disabled={busy}>Unmute</Button>
          </form>
        {:else if open === 'timedMute'}
          <form method="POST" action="?/addTimedMute" use:enhance={muteForm.enhance} class="flex flex-col gap-2">
            <input type="hidden" name="userId" value={suspectId} />
            <input type="hidden" name="hours" value={muteHours} />
            <!-- Presets only. A free-text hours box invites 240 where someone meant 24; an exact end date
                 is in User Lookup. -->
            <div class="flex flex-wrap gap-1">
              {#each MUTE_PRESETS as [value, label] (value)}
                <Button
                  type="button"
                  size="xs"
                  variant={muteHours === value ? 'default' : 'outline'}
                  onclick={() => (muteHours = value)}
                >
                  {label}
                </Button>
              {/each}
            </div>
            <Textarea name="reason" rows={2} placeholder="Why is this mute being applied?" required />
            <div class="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy}>Apply timed mute</Button>
              <Button type="button" size="sm" variant="ghost" onclick={() => (open = null)}>Cancel</Button>
            </div>
          </form>
        {:else}
          <div class="flex flex-wrap gap-2">
            <form method="POST" action="?/setMuted" use:enhance={muteForm.enhance}>
              <input type="hidden" name="userId" value={suspectId} />
              <input type="hidden" name="muted" value="true" />
              <Button type="submit" size="sm" variant="outline" disabled={busy}>Mute</Button>
            </form>
            <Button size="sm" variant="outline" onclick={() => (open = 'timedMute')}>Timed mute…</Button>
          </div>
        {/if}
      </div>

      <!-- Ban: its own grant on top of acting at all, as in User Lookup. -->
      <div class="flex flex-col gap-2 p-3">
        {@render heading(
          'Ban',
          account.bannedAt
            ? `Banned ${dateTime(account.bannedAt)}${account.banReason ? ` · ${account.banReason}` : ''}.`
            : 'Bans the account with a reason, and removes the content you choose.',
          account.bannedAt ? 'Banned' : null
        )}
        {#if banForm.error}<ErrorAlert message={banForm.error} />{/if}
        {#if !canBan}
          <p class="m-0 text-xs text-muted-foreground">Needs the Ban permission.</p>
        {:else if open === 'ban' && !account.bannedAt}
          <!-- Shared with User Lookup and the Audit ban forms: what a ban does to a user's content is a
               policy statement, and a second copy of it would drift. -->
          <BanConfirmForm
            userId={suspectId}
            username={account.username}
            action="?/setBanned"
            enhancer={banForm.enhance}
            busy={busy}
            onCancel={() => (open = null)}
          >
            {#snippet hidden()}
              <input type="hidden" name="userId" value={suspectId} />
              <input type="hidden" name="ban" value="true" />
            {/snippet}
          </BanConfirmForm>
        {:else if open === 'unban' && account.bannedAt}
          <form method="POST" action="?/setBanned" use:enhance={banForm.enhance} class="flex flex-col gap-2">
            <input type="hidden" name="userId" value={suspectId} />
            <input type="hidden" name="ban" value="false" />
            <span class="text-sm">Unban <strong>{account.username ?? suspectId}</strong>?</span>
            <div class="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy}>Yes, unban</Button>
              <Button type="button" size="sm" variant="ghost" onclick={() => (open = null)}>Cancel</Button>
            </div>
          </form>
        {:else}
          <div class="flex flex-wrap gap-2">
            {#if account.bannedAt}
              <Button size="sm" variant="outline" onclick={() => (open = 'unban')}>Unban</Button>
            {:else}
              <Button size="sm" variant="outline" onclick={() => (open = 'ban')}>Ban</Button>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Remove profile text. Named for what it removes and why: "Clear profile text" did not say which
           text, or that the point is a profile used as an ad or for abuse. -->
      <div class="flex flex-col gap-2 p-3">
        {@render heading(
          'Remove profile text',
          filledFields.length
            ? 'Deletes the bio, profile message or location from their public profile — for spam links or abusive text — without banning the account.'
            : 'Their profile has no bio, message or location.',
          null,
          !filledFields.length
        )}
        {#if open === 'clear' && filledFields.length}
          <form method="POST" action="?/clearProfileText" use:enhance={profileForm.enhance} class="flex flex-col gap-2">
            <input type="hidden" name="userId" value={suspectId} />
            {#if profileForm.error}<ErrorAlert message={profileForm.error} />{/if}
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <!-- Uncontrolled, as in User Lookup: the action reads `form.getAll('fields')`. -->
              {#each filledFields as [field, label] (field)}
                <div class="flex items-center gap-1.5">
                  <Checkbox id="clear-{field}-{uid}" name="fields" value={field} checked />
                  <Label for="clear-{field}-{uid}" class="text-xs font-normal">{label}</Label>
                </div>
              {/each}
            </div>
            <div class="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="destructive" disabled={busy}>
                Remove
              </Button>
              <Button type="button" size="sm" variant="ghost" onclick={() => (open = null)}>Cancel</Button>
            </div>
          </form>
        {:else if filledFields.length}
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onclick={() => (open = 'clear')}>Remove…</Button>
          </div>
        {/if}
      </div>

      <!-- Notify -->
      <div class="flex flex-col gap-2 p-3">
        {@render heading('Notify', 'Sends the user a message from the moderators.', null)}
        {#if open === 'notify'}
          <form method="POST" action="?/notify" use:enhance={notifyForm.enhance} class="flex flex-col gap-2">
            <input type="hidden" name="userId" value={suspectId} />
            {#if notifyForm.error}<ErrorAlert message={notifyForm.error} />{/if}
            <Textarea name="message" rows={3} placeholder="What should this user be told?" required />
            <div class="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy}>Send</Button>
              <Button type="button" size="sm" variant="ghost" onclick={() => (open = null)}>Cancel</Button>
            </div>
          </form>
        {:else}
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onclick={() => (open = 'notify')}>Notify</Button>
          </div>
        {/if}
      </div>
    </div>
    <p class="m-0 text-xs text-muted-foreground">
      Purging content, deleting the account and the rest are in
      <a href={userLookupUrl(suspectId)} class="link">User Lookup</a>.
    </p>
  </section>
{/if}
