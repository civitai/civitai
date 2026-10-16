<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import BanConfirmForm from '$lib/components/BanConfirmForm.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import StrikeList from '$lib/components/StrikeList.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import { entityUrl, userLookupUrl } from '$lib/entity-url';
  import type { StrikeReviewRow } from '$lib/server/strike-review.service';

  let {
    row,
    civitaiUrl,
    canBan,
  }: { row: StrikeReviewRow; civitaiUrl: string; canBan: boolean } = $props();

  const name = $derived(row.username ?? `#${row.userId}`);

  let banning = $state(false);
  let voiding = $state<number | null>(null);
  let voidReason = $state('');

  // One error line for three forms: it shows whichever form was submitted last, so an older refusal
  // cannot hide a newer one.
  let lastForm = $state<'ban' | 'unmute' | 'void' | null>(null);

  const ban = new FormState({
    onSubmit: () => (lastForm = 'ban'),
    reload: true,
    onSuccess: () => {
      banning = false;
      toast.success(`Banned ${name}`);
    },
  });
  const unmute = new FormState({
    onSubmit: () => (lastForm = 'unmute'),
    reload: true,
    onSuccess: () => toast.success(`Unmuted ${name}`),
  });
  const voidForm = new FormState({
    onSubmit: () => (lastForm = 'void'),
    reload: true,
    onSuccess: () => {
      voiding = null;
      voidReason = '';
      toast.success('Strike voided');
    },
  });

  const error = $derived(
    lastForm === 'ban'
      ? ban.error
      : lastForm === 'unmute'
        ? unmute.error
        : lastForm === 'void'
          ? voidForm.error
          : null
  );
</script>

<article class="flex flex-col gap-3 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="flex flex-col gap-1">
      <a href={userLookupUrl(row.username ?? row.userId)} class="{LINK_CLASS} font-semibold">{name}</a>
      <p class="text-xs text-dark-2">
        Flagged {row.flaggedAt ? `${relativeTime(row.flaggedAt)} · ${dateTime(row.flaggedAt)}` : 'at an unrecorded time'}
      </p>
    </div>
    <div class="flex flex-wrap gap-1.5">
      <Badge variant="destructive">{row.activePoints} active point{row.activePoints === 1 ? '' : 's'}</Badge>
      <Badge variant="secondary">
        {#if row.muteExpiresAt}Muted until {dateTime(row.muteExpiresAt)}{:else}Muted indefinitely{/if}
      </Badge>
      {#if row.mutedAt}
        <!-- `mutedAt` is set only by a moderator's mute; the strike system's own mute leaves it null. -->
        <Badge variant="outline">Moderator mute {dateTime(row.mutedAt)}</Badge>
      {/if}
    </div>
  </div>

  <StrikeList strikes={row.strikes}>
    {#snippet extra(strike, isSpent)}
      {@const link = entityUrl(civitaiUrl, strike.entityType, strike.entityId)}
      {#if link}
        <a href={link} target="_blank" rel="noreferrer" class="{LINK_CLASS} text-xs"
          >{strike.entityType} #{strike.entityId}</a
        >
      {:else if strike.entityType && strike.entityId}
        <span class="text-xs text-dark-2">{strike.entityType} #{strike.entityId}</span>
      {/if}
      {#if strike.voidReason}
        <span class="text-xs text-dark-2">· void reason: {strike.voidReason}</span>
      {/if}
      {#if !isSpent && voiding !== strike.id}
        <button
          type="button"
          class="text-xs text-yellow-300 hover:underline"
          onclick={() => {
            voiding = strike.id;
            voidReason = '';
          }}>Void</button
        >
      {/if}
      {#if voiding === strike.id}
        <form
          method="POST"
          action="?/voidStrike"
          use:enhance={voidForm.enhance}
          class="mt-1 flex w-full flex-col gap-2"
        >
          <input type="hidden" name="strikeId" value={strike.id} />
          <Textarea
            name="voidReason"
            bind:value={voidReason}
            placeholder="Why this strike should not stand (required)"
            maxlength={1000}
            rows={2}
          />
          <div class="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              disabled={voidForm.submitting || !voidReason.trim()}>Void strike</Button
            >
            <Button type="button" size="sm" variant="outline" onclick={() => (voiding = null)}
              >Cancel</Button
            >
          </div>
        </form>
      {/if}
    {/snippet}
  </StrikeList>

  {#if error}
    <p class="text-sm text-red-300">{error}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <form method="POST" action="?/unmute" use:enhance={unmute.enhance} class="flex items-center gap-2">
      <input type="hidden" name="userId" value={row.userId} />
      <ConfirmSubmit
        label="Unmute"
        name="op"
        value="unmute"
        count={1}
        noun="account"
        submitting={unmute.submitting}
      />
    </form>
    {#if canBan}
      <Button size="sm" variant="outline" onclick={() => (banning = !banning)}>Ban</Button>
    {/if}
  </div>

  {#if banning}
    <BanConfirmForm
      userId={row.userId}
      username={row.username}
      enhancer={ban.enhance}
      busy={ban.submitting}
      onCancel={() => (banning = false)}
    >
      {#snippet hidden()}
        <input type="hidden" name="userId" value={row.userId} />
      {/snippet}
    </BanConfirmForm>
  {/if}
</article>
