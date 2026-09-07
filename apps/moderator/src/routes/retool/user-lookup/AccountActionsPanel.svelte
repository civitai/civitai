<script lang="ts">
  import BanConfirmForm from '$lib/components/BanConfirmForm.svelte';
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import type { LayoutData } from './$types';
  import { LINK_CLASS } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { fetchSupport } from './user-support';
  import { REWARDS_ELIGIBILITY } from './enforcement-options';
  import { FormState } from '$lib/form-state.svelte';
  import { unwiredRulingReason } from '$lib/restriction-types';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  type Identity = NonNullable<LayoutData['result']>['identity'];


  let {
    identity,
    canAct,
    canToggleModerator,
    canBan,
    canPurge,
  }: {
    identity: Identity;
    canAct: boolean;
    canToggleModerator: boolean;
    /** Ban and purge are separate grants, not one "enforcement" right: purge has no way back. */
    canBan: boolean;
    canPurge: boolean;
  } =
    $props();


  let version = $state(0);
  let confirming = $state<'ban' | 'unban' | 'purge' | null>(null);
  let purgeConfirm = $state('');

  // One flag for the whole panel: these actions all act on the same account, and none of them is safe to
  // interleave with another.

  const support = $derived(browser ? fetchSupport(identity.id, version) : null);
  const mutesUrl = $derived(userLookupUrl(identity.id, 'mutes'));

  // A restriction of a type with no verdict path cannot be ruled on ANYWHERE — `resolveUserRestriction`
  // in the main app refuses it, which is what this panel posts through. Without this the panel offered
  // Overturn/Uphold on such a row, and clicking Overturn would have sent a "your generation access has
  // been restored" notice and reset the account's prompt-violation counter over an unrelated case.
  // Falls back to `generation` for a null type, matching the label below.
  const unwiredReason = $derived(unwiredRulingReason(identity.restrictionType ?? 'generation'));

  // `reload: true` because these writes change `identity`, which DOES come from `load` — unlike the
  // panels fed by `/api/*`, where reloading re-runs the reaction scan for nothing.
  //
  // `submitting` is not cosmetic. The ban endpoint answers 200 BEFORE it writes, so setBanned's
  // already-in-that-state guard is blind for the length of that write: two quick clicks both pass it,
  // both POST, and because the endpoint TOGGLES, the second one unbans. Nothing on screen changes in
  // between, because the success path re-reads the replica.
  const form = new FormState({
    reload: true,
    onSuccess: () => {
      confirming = null;
      purgeConfirm = '';
      version += 1;
    },
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Account actions</h3>

  {#if form.error}
    <ErrorAlert class="mb-3" message={form.error} />
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

    <!-- A PENDING restriction is a system ruling nobody has made yet, and the Unmute button beside it
         resolves none of it: the row stays Pending, the cancelled subscription stays cancelled, the
         prohibited-request count stays where it was and the user is never told. Overturn/Uphold is the
         one write path that does all of that, so it sits above the mute toggle rather than beside it. -->
    {#if identity.restrictionStatus === 'Pending' && identity.restrictionId}
      <div class="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
        <p class="mb-2 text-sm text-amber-200">
          A <strong>{identity.restrictionType ?? 'generation'}</strong> restriction on this account is
          awaiting a ruling. Unmuting alone leaves it Pending — rule on it here instead.
        </p>
        {#if unwiredReason}
          <p class="mb-2 text-sm text-amber-200">
            {unwiredReason} Review it in the
            <a href="/audit/generator-restrictions?type={identity.restrictionType}" class={LINK_CLASS}>
              restriction queue
            </a>.
          </p>
        {/if}
        <form method="POST" action="?/resolveRestriction" use:enhance={form.enhance} class="grid gap-2">
          <input type="hidden" name="userRestrictionId" value={identity.restrictionId} />
          <input type="hidden" name="userId" value={identity.id} />
          <Input
            name="resolvedMessage"
            placeholder="Message shown to the user with the ruling (optional)"
            class="max-w-lg"
          />
          <div class="flex flex-wrap gap-2">
            <!-- One field, two submits: a submit button contributes a single name/value pair. -->
            <Button
              type="submit"
              name="status"
              value="Overturned"
              size="sm"
              disabled={form.submitting || !!unwiredReason}
            >
              Overturn — lift it
            </Button>
            <Button
              type="submit"
              name="status"
              value="Upheld"
              size="sm"
              variant="destructive"
              disabled={form.submitting || !!unwiredReason}
            >
              Uphold — keep them muted
            </Button>
          </div>
        </form>
      </div>
    {/if}

    <div class="flex flex-wrap gap-2">
      <form method="POST" action="?/setMuted" use:enhance={form.enhance}>
        <input type="hidden" name="userId" value={identity.id} />
        <input type="hidden" name="muted" value={identity.muted ? 'false' : 'true'} />
        <Button type="submit" size="sm" disabled={form.submitting}>
          {identity.muted ? 'Unmute' : 'Mute'}
        </Button>
      </form>

      <form method="POST" action="?/forceLogout" use:enhance={form.enhance}>
        <input type="hidden" name="userId" value={identity.id} />
        <Button type="submit" size="sm" disabled={form.submitting}>Force logout</Button>
      </form>

      <form method="POST" action="?/resetCaches" use:enhance={form.enhance}>
        <input type="hidden" name="userId" value={identity.id} />
        <Button type="submit" size="sm" disabled={form.submitting}>Reset subscription caches</Button>
      </form>

      <form method="POST" action="?/refreshSession" use:enhance={form.enhance}>
        <input type="hidden" name="userId" value={identity.id} />
        <Button type="submit" size="sm" disabled={form.submitting}>Refresh session</Button>
      </form>

      <!-- Gated on the action's own grant, not on `canAct`: reaching this page and being allowed to end
           an account are different rights, and the server now enforces them separately. Showing a
           control the action will refuse is how an operator learns a permission exists by being told
           no. -->
      {#if canBan}
        {#if identity.bannedAt}
          <Button size="sm" onclick={() => (confirming = 'unban')}>Unban</Button>
        {:else}
          <Button size="sm" variant="destructive" onclick={() => (confirming = 'ban')}>Ban</Button>
        {/if}
      {/if}

      {#if canPurge}
        <Button size="sm" variant="destructive" onclick={() => (confirming = 'purge')}>
          Purge content
        </Button>
      {/if}
    </div>

    <div class="mt-4 border-t border-dark-4 pt-4">
      <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
        Rewards eligibility{identity.rewardsEligibility
          ? ` — currently ${identity.rewardsEligibility}`
          : ''}
      </h4>
      <form method="POST" action="?/setRewardsEligibility" use:enhance={form.enhance} class="flex gap-2">
        <input type="hidden" name="userId" value={identity.id} />
        {#each REWARDS_ELIGIBILITY as [value, label] (value)}
          <Button
            type="submit"
            name="eligibility"
            {value}
            size="sm"
            variant={identity.rewardsEligibility === value ? 'default' : 'outline'}
            disabled={form.submitting}
          >
            {label}
          </Button>
        {/each}
      </form>
    </div>

    {#if canToggleModerator}
      <div class="mt-4 border-t border-dark-4 pt-4">
        <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Moderator role</h4>
        <form method="POST" action="?/toggleModerator" use:enhance={form.enhance} class="flex gap-2">
          <input type="hidden" name="userId" value={identity.id} />
          <input type="hidden" name="isModerator" value={identity.isModerator ? 'false' : 'true'} />
          <Button
            type="submit"
            size="sm"
            variant={identity.isModerator ? 'destructive' : 'default'}
            disabled={form.submitting}
          >
            {identity.isModerator ? 'Deactivate moderator' : 'Activate moderator'}
          </Button>
        </form>
      </div>
    {/if}

    {#if confirming === 'purge'}
      <form method="POST" action="?/purgeContent" use:enhance={form.enhance} class="mt-4">
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
              disabled={form.submitting ||
                purgeConfirm !== (identity.username ?? String(identity.id))}
            >
              {form.submitting ? 'Working…' : 'Purge all content'}
            </Button>
            <Button type="button" size="sm" variant="outline" onclick={() => (confirming = null)}>
              Cancel
            </Button>
          </div>
        </div>
      </form>
    {:else if confirming === 'ban'}
      <div class="mt-4">
        <!-- Shared with the Audit ban forms: the paragraph describing what a ban does to a user's
             images is a policy statement, and three copies of it would next change in one or two. -->
        <BanConfirmForm
          userId={identity.id}
          username={identity.username}
          action="?/setBanned"
          enhancer={form.enhance}
          busy={form.submitting}
          onCancel={() => (confirming = null)}
        >
          {#snippet hidden()}
            <input type="hidden" name="userId" value={identity.id} />
            <input type="hidden" name="ban" value="true" />
          {/snippet}
        </BanConfirmForm>
      </div>
    {:else if confirming === 'unban'}
      <form method="POST" action="?/setBanned" use:enhance={form.enhance} class="mt-4">
        <input type="hidden" name="userId" value={identity.id} />
        <input type="hidden" name="ban" value="false" />
        <div class="rounded-md border border-dark-4 bg-dark-7 p-3">
          <p class="mb-2 text-sm text-white">
            Unban <strong>{identity.username ?? identity.id}</strong>?
          </p>
          <div class="mt-2 flex gap-2">
            <Button type="submit" size="sm" disabled={form.submitting}>
              {form.submitting ? 'Working…' : 'Confirm unban'}
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
      <div class="mt-5">
        <!-- The timed-mute list moved to its own section; an active one still needs saying here,
             because this is the screen a ban or an unmute is decided on. -->
        {#if result.timedMute}
          <p class="mb-4 text-sm text-amber-300">
            This account has an active timed mute — see
            <a href={mutesUrl} class={LINK_CLASS}>Timed Mutes</a>.
          </p>
        {/if}

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
