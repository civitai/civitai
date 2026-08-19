<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance, applyAction } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { ActionResult } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Switch } from '@civitai/ui/components/ui/switch/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import {
    CONTENT_MAX,
    DEFAULT_DOMAINS,
    DOMAIN_CHIPS,
    LINK_TEXT_MAX,
    TITLE_MAX,
    allowanceState,
    type AnnouncementAllowance,
    type AnnouncementDomain,
  } from '$lib/announcements';
  import type { AnnouncementRow } from '$lib/server/announcements';
  import CoverField from './CoverField.svelte';
  import type { CoverUpload } from './cover-upload';

  let {
    announcement = null,
    allowance,
    error = null,
    onDone,
  }: {
    announcement?: AnnouncementRow | null;
    allowance: AnnouncementAllowance | null;
    error?: string | null;
    onDone: () => void;
  } = $props();

  // Only the initial field values are frozen; everything rendered below reads the live prop, so a
  // row refreshed under us cannot leave a stale id in the hidden input.
  const seed = untrack(() => announcement);

  // `datetime-local` is wall-clock with no zone. Server-rendered it would format in the SERVER's
  // zone, so the effect below re-seeds it in the browser, and what actually posts is the ISO
  // instant derived there. No bare local string ever reaches the action.
  const toLocalInput = (value: Date | string | null | undefined) => {
    if (!value) return '';
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };

  const toInstant = (local: string) => {
    if (!local) return '';
    const date = new Date(local);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  };

  let title = $state(seed?.title ?? '');
  let content = $state(seed?.content ?? '');
  let domains = $state<AnnouncementDomain[]>(
    seed?.domain?.length ? [...new Set(seed.domain as AnnouncementDomain[])] : [...DEFAULT_DOMAINS]
  );
  let profileOnly = $state(seed?.profileOnly ?? false);
  let startsLocal = $state(toLocalInput(seed?.startsAt));
  let endsLocal = $state(toLocalInput(seed?.endsAt));
  let linkUrl = $state(seed?.link ?? '');

  // Shows the creator the adaptation the server performs on save: a link to one of our own
  // domains is stored as a path so it opens on whichever site the reader is on. This is the
  // visible half only — `toDomainRelativeLink` on the server is what actually decides, and
  // it reads the real host list from server env, which the browser has no business knowing.
  const OWN_HOSTS = ['civitai.com', 'civitai.red', 'civitaired.com'];

  function truncateOwnDomain() {
    const value = linkUrl.trim();
    if (!value) return;

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return; // already a path
    }

    const host = url.host.toLowerCase();
    const ours = OWN_HOSTS.includes(host) || host === window.location.host.toLowerCase();
    if (!ours) return;

    linkUrl = `${url.pathname}${url.search}${url.hash}` || '/';
  }
  let linkText = $state(seed?.linkText ?? '');
  let cover = $state<CoverUpload | null>(null);
  let submitting = $state(false);

  // Re-seed in the creator's own zone; the server rendered these in its own.
  $effect(() => {
    untrack(() => {
      startsLocal = toLocalInput(seed?.startsAt);
      endsLocal = toLocalInput(seed?.endsAt);
    });
  });

  const startsAt = $derived(toInstant(startsLocal));
  const endsAt = $derived(toInstant(endsLocal));

  const allowState = $derived(allowance ? allowanceState(allowance) : null);
  // A slot is spent on the profile-only → notifying transition, so editing an announcement that
  // already notifies costs nothing and must stay possible once the allowance is used up.
  const spendsSlot = $derived(!profileOnly && (!announcement || announcement.profileOnly));
  const blocked = $derived(spendsSlot && allowState !== null && allowState !== 'available');
  // The migrated profile banners carry no subject, and the server requires one on every write.
  const needsTitle = $derived(!!seed && seed.title.trim() === '' && title.trim() === '');

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function setDomains(next: string[]) {
    domains = (next.length ? next : [...DEFAULT_DOMAINS]) as AnnouncementDomain[];
  }

  const submit = () => {
    submitting = true;
    return async ({ result }: { result: ActionResult }) => {
      submitting = false;
      // A custom callback replaces the default one, which invalidates before it applies. Without
      // this the list and the allowance count keep showing pre-write state.
      if (result.type === 'success') await invalidateAll();
      await applyAction(result);
      if (result.type === 'success') onDone();
    };
  };
</script>

<form method="POST" action="?/save" use:enhance={submit} class="cs-panel p-5">
  <h2 class="text-base font-semibold text-white">
    {announcement ? 'Edit announcement' : 'New announcement'}
  </h2>

  {#if announcement}<input type="hidden" name="id" value={announcement.id} />{/if}
  <input type="hidden" name="domain" value={domains.join(',')} />
  <input type="hidden" name="profileOnly" value={profileOnly ? 'on' : 'false'} />
  <input type="hidden" name="startsAt" value={startsAt} />
  <input type="hidden" name="endsAt" value={endsAt} />
  {#if cover}
    <input type="hidden" name="coverKey" value={cover.key} />
    <input type="hidden" name="coverWidth" value={cover.width ?? ''} />
    <input type="hidden" name="coverHeight" value={cover.height ?? ''} />
    <input type="hidden" name="coverMimeType" value={cover.mimeType} />
    <input type="hidden" name="coverSizeKB" value={cover.sizeKB} />
  {/if}

  <div class="mt-4 flex flex-col gap-4">
    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline justify-between gap-2">
        <Label for="announcement-title">Subject</Label>
        <span class="text-xs text-dark-2">
          {#if needsTitle}
            This profile message has no subject yet — add one to save it.
          {:else}
            {title.length}/{TITLE_MAX}
          {/if}
        </span>
      </div>
      <Input
        id="announcement-title"
        name="title"
        bind:value={title}
        maxlength={TITLE_MAX}
        placeholder="What are you announcing?"
        required
      />
    </div>

    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline justify-between gap-2">
        <Label for="announcement-content">Message</Label>
        <span class="text-xs text-dark-2">{content.length}/{CONTENT_MAX}</span>
      </div>
      <Textarea
        id="announcement-content"
        name="content"
        bind:value={content}
        maxlength={CONTENT_MAX}
        rows={5}
        placeholder="Tell your followers what is happening."
        required
      />
    </div>

    <CoverField bind:cover existingUrl={announcement?.coverUrl} />

    <fieldset class="flex flex-col gap-1.5">
      <legend class="text-sm font-medium text-white">Where it shows</legend>
      <ToggleGroup
        type="multiple"
        variant="outline"
        spacing={2}
        bind:value={domains}
        onValueChange={setDomains}
      >
        {#each DOMAIN_CHIPS as chip (chip.color)}
          <ToggleGroupItem value={chip.color} aria-label={chip.label}>{chip.label}</ToggleGroupItem>
        {/each}
      </ToggleGroup>
      <span class="text-xs text-dark-2">
        {DOMAIN_CHIPS.filter((c) => domains.includes(c.color))
          .map((c) => c.host)
          .join(' · ')}
      </span>
    </fieldset>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="flex flex-col gap-1.5">
        <Label for="announcement-starts">Starts</Label>
        <Input id="announcement-starts" type="datetime-local" bind:value={startsLocal} />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="announcement-ends">Ends</Label>
        <Input id="announcement-ends" type="datetime-local" bind:value={endsLocal} />
      </div>
      <span class="text-xs text-dark-2 sm:col-span-2">
        Your local time{timeZone ? ` (${timeZone})` : ''}. Leave both empty to show it from now on.
      </span>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="flex flex-col gap-1.5">
        <Label for="announcement-link">Button link (optional)</Label>
        <Input
          id="announcement-link"
          name="linkUrl"
          bind:value={linkUrl}
          onblur={truncateOwnDomain}
          placeholder="/models/123 or https://…"
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="announcement-link-text">Button text</Label>
        <Input
          id="announcement-link-text"
          name="linkText"
          bind:value={linkText}
          maxlength={LINK_TEXT_MAX}
          placeholder="Check it out"
        />
      </div>
    </div>

    <div class="flex items-start gap-3 rounded-lg border border-dark-4 p-3">
      <Switch id="announcement-profile-only" bind:checked={profileOnly} />
      <div>
        <Label for="announcement-profile-only">Profile only</Label>
        <p class="text-sm text-dark-2">
          Shows on your profile, stays out of the feed, notifies nobody, and does not use a slot.
        </p>
      </div>
    </div>

    {#if blocked}
      <p class="text-sm text-dark-2">
        {allowState === 'ineligible'
          ? 'Your creator score is not high enough to notify followers yet — turn on Profile only to post this.'
          : 'No announcement slots left for this period — turn on Profile only to post this.'}
      </p>
    {/if}
    {#if error}<p class="text-sm text-red-300">{error}</p>{/if}

    <div class="flex gap-2">
      <Button type="submit" disabled={submitting || blocked}>
        {submitting ? 'Saving…' : announcement ? 'Save changes' : 'Post announcement'}
      </Button>
      <Button type="button" variant="ghost" onclick={onDone}>Cancel</Button>
    </div>
  </div>
</form>
