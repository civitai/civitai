<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import type { LayoutData } from './$types';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { FormResult } from './form-result';
  import { fetchSupport } from './user-support';
  import { BAN_REASONS, MUTE_PRESETS, REWARDS_ELIGIBILITY } from './enforcement-options';
  import { writeEnhancer } from '$lib/form-action';

  type Identity = NonNullable<LayoutData['result']>['identity'];


  let {
    identity,
    canAct,
    isSenior,
    form,
  }: { identity: Identity; canAct: boolean; isSenior: boolean; form: FormResult } = $props();

  const error = $derived(form?.scope === 'account' ? form.error : null);

  let version = $state(0);
  let confirming = $state<'ban' | 'unban' | 'purge' | null>(null);
  let purgeConfirm = $state('');
  let showTimedMute = $state(false);
  let reasonCode = $state('');
  let muteHours = $state(24);

  // One flag for the whole panel: these actions all act on the same account, and none of them is safe to
  // interleave with another.
  let submitting = $state(false);

  const support = $derived(browser ? fetchSupport(identity.id, version) : null);

  // `reload: true` because these writes change `identity`, which DOES come from `load` — unlike the
  // panels fed by `/api/*`, where reloading re-runs the reaction scan for nothing.
  //
  // `submitting` is not cosmetic. The ban endpoint answers 200 BEFORE it writes, so setBanned's
  // already-in-that-state guard is blind for the length of that write: two quick clicks both pass it,
  // both POST, and because the endpoint TOGGLES, the second one unbans. Nothing on screen changes in
  // between, because the success path re-reads the replica.
  const onSubmit = writeEnhancer({
    reload: true,
    onSuccess: () => {
      confirming = null;
      showTimedMute = false;
      reasonCode = '';
      purgeConfirm = '';
      version += 1;
    },
    busy: (v) => (submitting = v),
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Account actions</h3>

  {#if error}
    <div
      class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
      role="alert"
    >
      {error}
    </div>
  {/if}

  {#if !canAct}
    <p class="text-sm text-dark-2">
      You can view this account but not act on it. Enforcement requires the Users permission.
    </p>
  {:else}
    <p class="mb-3 text-xs text-dark-2">
      Every action is recorded against your account. Banning unpublishes their models and notifies
      them. It does <strong>not</strong> block their images unless the reason is Sexual Minor — remove
      those separately in Bulk Image Manager.
    </p>

    <div class="flex flex-wrap gap-2">
      <form method="POST" action="?/setMuted" use:enhance={onSubmit}>
        <input type="hidden" name="userId" value={identity.id} />
        <input type="hidden" name="muted" value={identity.muted ? 'false' : 'true'} />
        <Button type="submit" size="sm" disabled={submitting}>
          {identity.muted ? 'Unmute' : 'Mute'}
        </Button>
      </form>

      <form method="POST" action="?/forceLogout" use:enhance={onSubmit}>
        <input type="hidden" name="userId" value={identity.id} />
        <Button type="submit" size="sm" disabled={submitting}>Force logout</Button>
      </form>

      <Button size="sm" onclick={() => (showTimedMute = !showTimedMute)}>Timed mute</Button>

      <form method="POST" action="?/resetCaches" use:enhance={onSubmit}>
        <input type="hidden" name="userId" value={identity.id} />
        <Button type="submit" size="sm" disabled={submitting}>Reset subscription caches</Button>
      </form>

      <form method="POST" action="?/refreshSession" use:enhance={onSubmit}>
        <input type="hidden" name="userId" value={identity.id} />
        <Button type="submit" size="sm" disabled={submitting}>Refresh session</Button>
      </form>

      {#if identity.bannedAt}
        <Button size="sm" onclick={() => (confirming = 'unban')}>Unban</Button>
      {:else}
        <Button size="sm" variant="destructive" onclick={() => (confirming = 'ban')}>Ban</Button>
      {/if}

      <Button size="sm" variant="destructive" onclick={() => (confirming = 'purge')}>
        Purge content
      </Button>
    </div>

    {#if showTimedMute}
      <form method="POST" action="?/addTimedMute" use:enhance={onSubmit} class="mt-4">
        <input type="hidden" name="userId" value={identity.id} />
        <div class="flex flex-wrap items-end gap-2">
          <label class="text-xs text-dark-2">
            Duration
            <!-- Retool's presetMutes. A free-text hours box invites 240 where someone meant 24. -->
            <div class="mt-1 flex gap-1">
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
            <input type="hidden" name="hours" value={muteHours} />
          </label>
          <label class="flex-1 text-xs text-dark-2">
            Reason
            <Input name="reason" placeholder="Why is this mute being applied?" class="mt-1" required />
          </label>
          <Button type="submit" size="sm" disabled={submitting}>Apply</Button>
        </div>
      </form>
    {/if}

    <div class="mt-4 border-t border-dark-4 pt-4">
      <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
        Rewards eligibility{identity.rewardsEligibility
          ? ` — currently ${identity.rewardsEligibility}`
          : ''}
      </h4>
      <form method="POST" action="?/setRewardsEligibility" use:enhance={onSubmit} class="flex gap-2">
        <input type="hidden" name="userId" value={identity.id} />
        {#each REWARDS_ELIGIBILITY as [value, label] (value)}
          <Button
            type="submit"
            name="eligibility"
            {value}
            size="sm"
            variant={identity.rewardsEligibility === value ? 'default' : 'outline'}
            disabled={submitting}
          >
            {label}
          </Button>
        {/each}
      </form>
    </div>

    {#if isSenior}
      <div class="mt-4 border-t border-dark-4 pt-4">
        <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Moderator role</h4>
        <form method="POST" action="?/toggleModerator" use:enhance={onSubmit} class="flex gap-2">
          <input type="hidden" name="userId" value={identity.id} />
          <input type="hidden" name="isModerator" value={identity.isModerator ? 'false' : 'true'} />
          <Button
            type="submit"
            size="sm"
            variant={identity.isModerator ? 'destructive' : 'default'}
            disabled={submitting}
          >
            {identity.isModerator ? 'Deactivate moderator' : 'Activate moderator'}
          </Button>
        </form>
      </div>
    {/if}

    {#if confirming === 'purge'}
      <form method="POST" action="?/purgeContent" use:enhance={onSubmit} class="mt-4">
        <input type="hidden" name="userId" value={identity.id} />
        <div class="rounded-md border border-red-500/40 bg-red-500/10 p-3">
          <p class="mb-2 text-sm text-white">
            Delete <strong>all content</strong> belonging to
            <strong>{identity.username ?? identity.id}</strong> — models, images, posts, articles and
            comments. This cannot be undone from here.
          </p>
          <label class="text-xs text-dark-2">
            Type <code class="text-dark-0">{identity.username ?? identity.id}</code> to confirm
            <Input name="confirm" bind:value={purgeConfirm} class="mt-1" autocomplete="off" />
          </label>
          <div class="mt-2 flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              disabled={submitting || purgeConfirm !== (identity.username ?? String(identity.id))}
            >
              {submitting ? 'Working…' : 'Purge all content'}
            </Button>
            <Button type="button" size="sm" variant="outline" onclick={() => (confirming = null)}>
              Cancel
            </Button>
          </div>
        </div>
      </form>
    {:else if confirming}
      <form method="POST" action="?/setBanned" use:enhance={onSubmit} class="mt-4">
        <input type="hidden" name="userId" value={identity.id} />
        <input type="hidden" name="ban" value={confirming === 'ban' ? 'true' : 'false'} />
        <div
          class="rounded-md border p-3 {confirming === 'ban'
            ? 'border-red-500/40 bg-red-500/10'
            : 'border-dark-4 bg-dark-7'}"
        >
          <p class="mb-2 text-sm text-white">
            {#if confirming === 'ban'}
              Ban <strong>{identity.username ?? identity.id}</strong>? Unpublishes their models and
              notifies them. Images stay up unless the reason is Sexual Minor, or you tick below.
            {:else}
              Unban <strong>{identity.username ?? identity.id}</strong>?
            {/if}
          </p>
          {#if confirming === 'ban'}
            <Select.Root type="single" name="reasonCode" bind:value={reasonCode}>
              <Select.Trigger class="mb-2 w-full">
                {reasonCode || 'Reason code (optional)'}
              </Select.Trigger>
              <Select.Content>
                {#each BAN_REASONS as reason (reason)}
                  <Select.Item value={reason}>{reason}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <Textarea name="detailsInternal" rows={2} placeholder="Internal notes (optional)" />
            <!-- Stored on the ban and read back by the appeal flow. Not emailed to the user. -->
            <Textarea
              name="detailsExternal"
              rows={2}
              placeholder="Rationale for the appeal record (optional)"
              class="mt-2"
            />
            <div class="mt-2 flex items-center gap-2">
              <Checkbox id="ban-remove-media" name="removeMedia" />
              <Label for="ban-remove-media" class="font-normal text-dark-0">
                Also remove their images
              </Label>
            </div>
          {/if}
          <div class="mt-2 flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={submitting}
              variant={confirming === 'ban' ? 'destructive' : 'default'}
            >
              {submitting ? 'Working…' : `Confirm ${confirming}`}
            </Button>
            <Button type="button" size="sm" variant="outline" onclick={() => (confirming = null)}>
              Cancel
            </Button>
          </div>
        </div>
      </form>
    {/if}
  {/if}

  {#await support}
    <p class="mt-5 text-sm text-dark-2">Loading mutes and support context…</p>
  {:then result}
    {#if result}
      <div class="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            Timed mutes ({result.timedMutes.length})
          </h4>
          {#if result.timedMutes.length === 0}
            <p class="text-sm text-dark-2">None.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.timedMutes as m (m.id)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  {#if m.active}<Badge variant="destructive">active</Badge>{:else}<Badge
                      variant="secondary">ended</Badge
                    >{/if}
                  <span class="text-dark-0">until {dateTime(m.muteEnd)}</span>
                  <span class="text-xs text-dark-2">{m.createdBy ?? 'unknown'}</span>
                  {#if m.active && canAct}
                    <form method="POST" action="?/revokeTimedMute" use:enhance={onSubmit}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="userId" value={identity.id} />
                      <button type="submit" disabled={submitting} class="text-xs {LINK_CLASS}">
                        revoke
                      </button>
                    </form>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Support</h4>
          {#if result.freshdesk.status === 'found'}
            {@const contact = result.freshdesk.contact}
            <a href={contact.url} target="_blank" rel="noreferrer" class="text-sm {LINK_CLASS}">
              {contact.name ?? contact.email ?? `contact ${contact.id}`}
            </a>
          {:else if result.freshdesk.status === 'none'}
            <p class="text-sm text-dark-2">No Freshdesk contact for this email.</p>
          {:else}
            <p class="text-sm text-amber-300">
              Could not check Freshdesk — {result.freshdesk.reason} This account may still have contacted
              support.
            </p>
          {/if}
        </div>
      </div>
    {/if}
  {:catch}
    <p class="mt-5 text-sm text-red-300">Could not load mutes or support context.</p>
  {/await}
</section>
