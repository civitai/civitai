<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import type { UserIdentity, UserProfileText } from '$lib/server/user-lookup.service';

  // What an account shows the world about itself — avatar, covers, bio, profile message, location.
  // Shared by User Lookup and the user-report queue: a bio used as an ad is the commonest spam report,
  // and the queue showing only images meant judging one meant leaving for the lookup.
  let {
    identity,
    profile,
    textActions,
    variant = 'panel',
  }: {
    identity: Pick<
      UserIdentity,
      'id' | 'username' | 'profilePictureUrl' | 'profilePictureType' | 'profilePictureNsfwLevel'
    >;
    profile: UserProfileText | null;
    /** Rendered under the profile text, when there is any — User Lookup's "Clear profile text". */
    textActions?: Snippet;
    /** `plain` drops the dividers and stacks the text full width, for a host that already frames it.
     *  In three columns a long profile message became a narrow column of wrapped lines. */
    variant?: 'panel' | 'plain';
  } = $props();

  const plain = $derived(variant === 'plain');

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
</script>

{#if plain}
  <!-- Text first and full width: in a report it is usually the evidence, and the media is context. -->
  {#if profileText.length}
    <dl class="flex flex-col gap-3 text-sm">
      {#each profileText as [label, value] (label)}
        <div>
          <dt class="mb-0.5 text-xs text-dark-2">{label}</dt>
          <dd class="max-w-prose whitespace-pre-wrap wrap-break-word text-dark-0">{value}</dd>
        </div>
      {/each}
    </dl>
    {@render textActions?.()}
  {/if}
  {#if media.length}
    <div class="mt-4 flex flex-wrap gap-3">
      {#each media as m (m.label)}
        <figure class="w-28">
          <EdgeMedia
            src={m.url}
            type={m.type === 'video' ? 'video' : 'image'}
            width={240}
            alt="{m.label} for {identity.username ?? identity.id}"
            class="size-28 rounded-md border border-dark-4 object-cover"
          />
          <figcaption class="mt-1 flex items-baseline justify-between gap-1 text-xs text-dark-2">
            {m.label}
            <Badge variant={(m.nsfwLevel ?? 0) >= 8 ? 'destructive' : 'secondary'}>
              {getBrowsingLevelLabel(m.nsfwLevel)}
            </Badge>
          </figcaption>
        </figure>
      {/each}
    </div>
  {/if}
{:else}
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
      {@render textActions?.()}
    </div>
  {/if}
{/if}
