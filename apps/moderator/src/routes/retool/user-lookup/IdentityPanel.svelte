<script lang="ts">
  import { enhance } from '$app/forms';
  import { FormState } from '$lib/form-state.svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import type { LayoutData } from './$types';
  import { userUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { OnboardingStep, hasOnboardingStep } from '$lib/onboarding';
  import { PROFILE_FIELDS } from './enforcement-options';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';

  type Identity = NonNullable<LayoutData['result']>['identity'];
  type Profile = NonNullable<LayoutData['result']>['profile'];
  type Curator = NonNullable<LayoutData['result']>['curator'];
  type Subscription = NonNullable<LayoutData['result']>['subscription'];

  let {
    identity,
    profile,
    curator,
    subscription,
    canAct,
    canEditIdentity,
    civitaiUrl,
  }: {
    identity: Identity;
    profile: Profile;
    curator: Curator;
    subscription: Subscription;
    canAct: boolean;
    canEditIdentity: boolean;
    civitaiUrl: string;
  } = $props();

  // Both forms on this panel: clearing profile text, and the Enable Edits identity form. Local, so
  // neither shows up in the four other panels that share this page.
  let clearing = $state(false);

  // `reload` on both: the bio and the identity row come from `load`, so unlike the client-fetched
  // panels this one does need the page data back after a write.
  const clearForm = new FormState({
    reload: true,
    onSuccess: () => (clearing = false),
  });

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

  // `status` is the provider's, and a cancelled-but-not-yet-expired plan still reads `active` there —
  // so a lapsed member and a paying one must not render the same. Anything other than `active` is shown
  // as-is rather than collapsed to "free": "past_due" is the state a support question is usually about.
  const membership = $derived.by(() => {
    if (!subscription) return { label: 'Free', paying: false };
    const plan = subscription.productName ?? 'Member';
    if (subscription.status !== 'active')
      return { label: `${plan} (${subscription.status})`, paying: false };
    return {
      label: subscription.cancelAtPeriodEnd ? `${plan} (ending)` : plan,
      paying: true,
    };
  });

  // Retool's Quick Info checkbox block. Read-only here: `UserContent` selected every one of these and
  // none of them reached the DOM, so the gap was seeing them — editing an account's own TOS acceptance
  // or browsing preferences is a separate capability, not a checkbox on the landing screen.
  const quickInfo = $derived<[string, boolean][]>([
    ['Accepted TOS', hasOnboardingStep(identity.onboarding, OnboardingStep.TOS)],
    ['Accepted Red TOS', hasOnboardingStep(identity.onboarding, OnboardingStep.RedTOS)],
    ['Excluded from leaderboards', !!identity.excludeFromLeaderboards],
    // Retool's Buzz-Blocked. `Ineligible` is what the Add Buzz-Block button writes.
    ['Buzz-blocked', identity.rewardsEligibility === 'Ineligible'],
    ['FP curator', curator.isCurator],
    ['Shows mature content', !!identity.showNsfw],
    ['Blurs mature content', !!identity.blurNsfw],
  ]);

  // Joining and being banned from it are separate bits, and an account can carry both — the ban is the
  // one that decides what a moderator does next, so it wins the label rather than being appended.
  const creatorProgram = $derived(
    hasOnboardingStep(identity.onboarding, OnboardingStep.BannedCreatorProgram)
      ? { label: 'Creator Program (banned)', variant: 'destructive' as const }
      : hasOnboardingStep(identity.onboarding, OnboardingStep.CreatorProgram)
        ? { label: 'Creator Program', variant: 'secondary' as const }
        : null
  );

  const fields = $derived<[string, string][]>([
    ['Full name', identity.name ?? '—'],
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
  // Its own state, not shared with the clear-profile form below: a refusal from one belongs beside the
  // form that produced it, and this one's was invisible while both shared a slot only the other wrote.
  const editForm = new FormState({
    reload: true,
    onSuccess: () => (editing = false),
  });

  const startEditing = () => {
    editUsername = identity.username ?? '';
    editEmail = identity.email ?? '';
    editName = identity.name ?? '';
    editing = true;
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
    <!-- Whether they pay is a fact about the account, and it decided how several enforcement calls get
         made — it lived only under Buzz, three clicks from the page a moderator opens first. The full
         subscription record stays there; this is the one line of it that belongs with the identity. -->
    <Badge variant={membership.paying ? 'secondary' : 'outline'}>{membership.label}</Badge>
    {#if creatorProgram}
      <Badge variant={creatorProgram.variant}>{creatorProgram.label}</Badge>
    {/if}
  </div>

  <div class="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
    {#each quickInfo as [label, on] (label)}
      <span class={on ? 'text-dark-0' : 'text-dark-2'}>
        <span aria-hidden="true">{on ? '☑' : '☐'}</span>
        {label}
      </span>
    {/each}
  </div>

  <dl class="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
    {#each fields as [label, value] (label)}
      <div>
        <dt class="text-xs tracking-wide text-dark-2 uppercase">{label}</dt>
        <dd class="text-dark-0 break-all">{value}</dd>
      </div>
    {/each}

    {#if canEditIdentity}
      <div class="sm:col-span-2 lg:col-span-3">
        {#if !editing}
          <Button size="sm" variant="outline" onclick={startEditing}>Enable edits</Button>
        {:else}
          <form
            method="POST"
            action="?/updateIdentity"
            use:enhance={editForm.enhance}
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
            <Button type="submit" size="sm" disabled={editForm.submitting}>
              {editForm.submitting ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" size="sm" variant="outline" onclick={() => (editing = false)}>
              Cancel
            </Button>
            <!-- The endpoint gates this on `retoolUpdateIdentity`, so a moderator without that grant
                 gets a refusal from the API rather than a silent no-op. -->
            <p class="w-full text-xs text-dark-2">
              Requires the identity-edit permission; the API refuses it otherwise.
            </p>
            {#if editForm.error}
              <div
                class="w-full rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
                role="alert"
              >
                {editForm.error}
              </div>
            {/if}
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
  </dl>

  {#if clearForm.error}
    <div
      class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
      role="alert"
    >
      {clearForm.error}
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
        <form method="POST" action="?/clearProfileText" use:enhance={clearForm.enhance} class="mt-3">
          <input type="hidden" name="userId" value={identity.id} />
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            {#each PROFILE_FIELDS as [field, label] (field)}
              <label class="flex items-center gap-1.5 text-xs text-dark-2">
                <input type="checkbox" name="fields" value={field} class="accent-blue-500" />
                {label}
              </label>
            {/each}
            <Button type="submit" size="sm" variant="destructive" disabled={clearForm.submitting}>Clear</Button>
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
