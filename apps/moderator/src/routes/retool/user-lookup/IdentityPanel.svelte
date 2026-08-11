<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { ActionResult } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import type { LayoutData } from './$types';
  import { userUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { FormResult } from './form-result';
  import { PROFILE_FIELDS } from './enforcement-options';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';

  type Identity = NonNullable<LayoutData['result']>['identity'];
  type Profile = NonNullable<LayoutData['result']>['profile'];
  type Curator = NonNullable<LayoutData['result']>['curator'];

  let {
    identity,
    profile,
    curator,
    canAct,
    form,
    civitaiUrl,
  }: {
    identity: Identity;
    profile: Profile;
    curator: Curator;
    canAct: boolean;
    form: FormResult;
    civitaiUrl: string;
  } = $props();

  // Both forms on this panel: clearing profile text, and the Enable Edits identity form.
  const error = $derived(
    form?.scope === 'profile' || form?.scope === 'identity' ? form.error : null
  );

  let clearing = $state(false);
  let submitting = $state(false);

  const afterWrite =
    () =>
    async ({ result }: { result: ActionResult }) => {
      await applyAction(result);
      if (result.type === 'success') {
        clearing = false;
        // The bio comes from `load`, so unlike the client-fetched panels this one does need it back.
        await invalidateAll();
      }
      submitting = false;
    };

  const onSubmit = () => {
    submitting = true;
    return afterWrite();
  };

  const profileText = $derived(
    [
      ['Bio', profile?.bio],
      ['Profile message', profile?.message],
      ['Location', profile?.location],
    ].filter((entry): entry is [string, string] => !!entry[1]?.trim())
  );

  // Retool's "Look at PFP" / "Look at Cover Image". Shown here rather than linked, because the
  // alternative is loading the profile of an account you may be about to act on.
  const media = $derived(
    [
      identity.profilePictureUrl
        ? {
            label: 'Avatar',
            url: identity.profilePictureUrl,
            type: identity.profilePictureType,
            nsfwLevel: identity.profilePictureNsfwLevel,
          }
        : null,
      profile?.coverImage ? { label: 'Cover', ...profile.coverImage } : null,
      profile?.sfwCoverImage ? { label: 'Cover (SFW)', ...profile.sfwCoverImage } : null,
    ].filter((m): m is NonNullable<typeof m> => m !== null)
  );

  const profileUrl = $derived(
    identity.username ? userUrl(civitaiUrl, identity.username) : null
  );

  const fields = $derived<[string, string][]>([
    ['Email', identity.email ?? '—'],
    ['Email verified', dateTime(identity.emailVerified)],
    ['Joined', dateTime(identity.createdAt)],
    ['Deleted', dateTime(identity.deletedAt)],
    ['Muted at', dateTime(identity.mutedAt)],
    ['Banned at', dateTime(identity.bannedAt)],
    ['Rewards eligibility', identity.rewardsEligibility ?? '—'],
  ]);

  // Retool's `Enable Edits` toggle over username / email / full name. Off by default and off again
  // after every save: these are the fields a mistyped edit is hardest to notice and worst to leave.
  let editing = $state(false);
  let editUsername = $state('');
  let editEmail = $state('');
  let editName = $state('');
  let saving = $state(false);

  const startEditing = () => {
    editUsername = identity.username ?? '';
    editEmail = identity.email ?? '';
    editName = identity.name ?? '';
    editing = true;
  };

  const afterSave =
    () =>
    async ({ result }: { result: ActionResult }) => {
      await applyAction(result);
      if (result.type === 'success') {
        editing = false;
        await invalidateAll();
      }
      saving = false;
    };
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h2 class="text-lg font-semibold text-white">
      {#if profileUrl}
        <a href={profileUrl} target="_blank" rel="noreferrer" class={LINK_CLASS}>
          {identity.username}
        </a>
      {:else}
        (no username)
      {/if}
    </h2>
    <code class="text-sm text-dark-2">#{identity.id}</code>
    {#if identity.bannedAt}
      <Badge variant="destructive">banned</Badge>
    {/if}
    {#if identity.muted}
      <Badge variant="destructive">muted</Badge>
    {/if}
    {#if identity.deletedAt}
      <Badge variant="secondary">deleted</Badge>
    {/if}
    {#if identity.isModerator}
      <Badge variant="secondary">moderator</Badge>
    {/if}
    {#if curator.isCurator}
      <Badge variant="secondary">
        curator ({curator.collectionIds.join(', ')})
      </Badge>
    {/if}
  </div>

  <dl class="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
    {#each fields as [label, value] (label)}
      <div>
        <dt class="text-xs tracking-wide text-dark-2 uppercase">{label}</dt>
        <dd class="text-dark-0 break-all">{value}</dd>
      </div>
    {/each}

    {#if canAct}
      <div class="sm:col-span-2 lg:col-span-3">
        {#if !editing}
          <Button size="sm" variant="outline" onclick={startEditing}>Enable edits</Button>
        {:else}
          <form
            method="POST"
            action="?/updateIdentity"
            use:enhance={() => {
              saving = true;
              return afterSave();
            }}
            class="flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="userId" value={identity.id} />
            <label class="flex flex-col gap-1 text-xs text-dark-2">
              Username
              <Input name="username" bind:value={editUsername} class="w-52" />
            </label>
            <label class="flex flex-col gap-1 text-xs text-dark-2">
              Email
              <Input name="email" type="email" bind:value={editEmail} class="w-64" />
            </label>
            <label class="flex flex-col gap-1 text-xs text-dark-2">
              Full name
              <Input name="name" bind:value={editName} class="w-52" />
            </label>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" size="sm" variant="outline" onclick={() => (editing = false)}>
              Cancel
            </Button>
            <!-- The endpoint gates this on `retoolUpdateIdentity`, so a moderator without that grant
                 gets a refusal from the API rather than a silent no-op. -->
            <p class="w-full text-xs text-dark-2">
              Requires the identity-edit permission; the API refuses it otherwise.
            </p>
          </form>
        {/if}
      </div>
    {/if}

    <div>
      <dt class="text-xs tracking-wide text-dark-2 uppercase">Stripe customer</dt>
      <dd class="break-all">
        {#if identity.customerId}
          <a
            href="https://dashboard.stripe.com/customers/{identity.customerId}"
            target="_blank"
            rel="noreferrer"
            class={LINK_CLASS}>{identity.customerId}</a
          >
        {:else}
          <span class="text-dark-0">—</span>
        {/if}
      </dd>
    </div>
    <div>
      <dt class="text-xs tracking-wide text-dark-2 uppercase">Paddle customer</dt>
      <dd class="break-all">
        {#if identity.paddleCustomerId}
          <a
            href="https://vendors.paddle.com/customers-v2/{identity.paddleCustomerId}"
            target="_blank"
            rel="noreferrer"
            class={LINK_CLASS}>{identity.paddleCustomerId}</a
          >
        {:else}
          <span class="text-dark-0">—</span>
        {/if}
      </dd>
    </div>
  </dl>

  {#if error}
    <div
      class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
      role="alert"
    >
      {error}
    </div>
  {/if}

  {#if media.length}
    <div class="mt-4 border-t border-dark-4 pt-4">
      <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Profile media</h4>
      <div class="flex flex-wrap gap-4">
        {#each media as m (m.label)}
          <figure class="w-40">
            <EdgeMedia
              src={m.url}
              type={m.type === 'video' ? 'video' : 'image'}
              width={320}
              alt="{m.label} for {identity.username ?? identity.id}"
              class="h-32 w-40 rounded-md border border-dark-4 object-cover"
            />
            <figcaption class="mt-1 flex items-baseline gap-2 text-xs text-dark-2">
              {m.label}
              <Badge variant={(m.nsfwLevel ?? 0) >= 8 ? 'destructive' : 'secondary'}>
                {getBrowsingLevelLabel(m.nsfwLevel)}
              </Badge>
            </figcaption>
          </figure>
        {/each}
      </div>
    </div>
  {/if}

  {#if profileText.length}
    <div class="mt-4 border-t border-dark-4 pt-4">
      <dl class="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
        {#each profileText as [label, value] (label)}
          <div>
            <dt class="text-xs tracking-wide text-dark-2 uppercase">{label}</dt>
            <dd class="whitespace-pre-wrap text-dark-0">{value}</dd>
          </div>
        {/each}
      </dl>

      <!-- The moderation case is a bio used as an ad or abuse surface: the text has to come off the
           site without banning the account over it. -->
      {#if canAct && !clearing}
        <button type="button" class="mt-3 text-xs {LINK_CLASS}" onclick={() => (clearing = true)}>
          Clear profile text
        </button>
      {:else if canAct}
        <form method="POST" action="?/clearProfileText" use:enhance={onSubmit} class="mt-3">
          <input type="hidden" name="userId" value={identity.id} />
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            {#each PROFILE_FIELDS as [field, label] (field)}
              <label class="flex items-center gap-1.5 text-xs text-dark-2">
                <input type="checkbox" name="fields" value={field} class="accent-blue-500" />
                {label}
              </label>
            {/each}
            <Button type="submit" size="sm" variant="destructive" disabled={submitting}>Clear</Button>
            <Button type="button" size="sm" variant="outline" onclick={() => (clearing = false)}>
              Cancel
            </Button>
          </div>
        </form>
      {/if}
    </div>
  {/if}

  {#if identity.banReason || identity.banDetails}
    <div class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm">
      <div class="font-medium text-red-300">Ban reason: {identity.banReason ?? '—'}</div>
      {#if identity.banDetails}
        <p class="mt-1 text-red-200/80">{identity.banDetails}</p>
      {/if}
    </div>
  {/if}
</section>
