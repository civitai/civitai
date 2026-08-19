<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance, applyAction } from '$app/forms';
  import type { ActionResult } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Switch } from '@civitai/ui/components/ui/switch/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import {
    CONTENT_MAX,
    DEFAULT_DOMAIN,
    DOMAIN_COLORS,
    DOMAIN_LABELS,
    LINK_TEXT_MAX,
    TITLE_MAX,
    allowanceState,
    type AnnouncementAllowance,
    type AnnouncementDomain,
  } from '$lib/announcements';
  import type { AnnouncementRow } from '$lib/server/announcements';
  import { COVER_ACCEPT, uploadCover, type CoverUpload } from './cover-upload';

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

  // Seeded once from the prop; the parent keys this component on the announcement being edited, so a
  // different subject remounts rather than merging into a half-typed draft.
  const seed = untrack(() => announcement);

  const toLocalInput = (value: Date | string | null | undefined) => {
    if (!value) return '';
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };

  let title = $state(seed?.title ?? '');
  let content = $state(seed?.content ?? '');
  let domains = $state<AnnouncementDomain[]>(
    seed?.domain?.length ? (seed.domain as AnnouncementDomain[]) : [DEFAULT_DOMAIN]
  );
  let profileOnly = $state(seed?.profileOnly ?? false);
  let startsAt = $state(toLocalInput(seed?.startsAt));
  let endsAt = $state(toLocalInput(seed?.endsAt));
  let linkUrl = $state(seed?.link ?? '');
  let linkText = $state(seed?.linkText ?? '');
  let cover = $state<CoverUpload | null>(null);
  let coverError = $state<string | null>(null);
  let uploading = $state(false);
  let submitting = $state(false);

  const allowState = $derived(allowance ? allowanceState(allowance) : null);
  // Profile-only never spends a slot, so it stays postable in every allowance state.
  const blocked = $derived(!profileOnly && allowState !== null && allowState !== 'available');

  function toggleDomain(domain: AnnouncementDomain) {
    if (domain === 'all') {
      domains = ['all'];
      return;
    }
    const without = domains.filter((d) => d !== domain && d !== 'all');
    domains = domains.includes(domain)
      ? without.length
        ? without
        : [DEFAULT_DOMAIN]
      : [...without, domain];
  }

  async function onCoverChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    coverError = null;
    uploading = true;
    try {
      cover = await uploadCover(file);
    } catch (e) {
      coverError = e instanceof Error ? e.message : 'The image could not be uploaded.';
      input.value = '';
    } finally {
      uploading = false;
    }
  }

  const submit = () => {
    submitting = true;
    return async ({ result }: { result: ActionResult }) => {
      submitting = false;
      await applyAction(result);
      if (result.type === 'success') onDone();
    };
  };
</script>

<form
  method="POST"
  action="?/save"
  use:enhance={submit}
  class="rounded-xl border border-dark-4 bg-dark-6 p-5"
>
  <h2 class="text-base font-semibold text-white">
    {seed ? 'Edit announcement' : 'New announcement'}
  </h2>

  {#if seed}<input type="hidden" name="id" value={seed.id} />{/if}
  <input type="hidden" name="domain" value={domains.join(',')} />
  <input type="hidden" name="profileOnly" value={profileOnly ? 'on' : 'false'} />
  {#if cover}
    <input type="hidden" name="coverKey" value={cover.key} />
    <input type="hidden" name="coverWidth" value={cover.width ?? ''} />
    <input type="hidden" name="coverHeight" value={cover.height ?? ''} />
    <input type="hidden" name="coverMimeType" value={cover.mimeType} />
    <input type="hidden" name="coverSizeKB" value={cover.sizeKB} />
  {/if}

  <div class="mt-4 flex flex-col gap-4">
    <div class="flex flex-col gap-1.5">
      <Label for="announcement-title">Subject</Label>
      <Input
        id="announcement-title"
        name="title"
        bind:value={title}
        maxlength={TITLE_MAX}
        placeholder="What are you announcing?"
        required
      />
      <span class="text-xs text-dark-2">{title.length}/{TITLE_MAX}</span>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="announcement-content">Message</Label>
      <Textarea
        id="announcement-content"
        name="content"
        bind:value={content}
        maxlength={CONTENT_MAX}
        rows={5}
        placeholder="Tell your followers what is happening."
        required
      />
      <span class="text-xs text-dark-2">{content.length}/{CONTENT_MAX}</span>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="announcement-cover">Cover image</Label>
      <div class="flex items-center gap-3">
        <input
          id="announcement-cover"
          type="file"
          accept={COVER_ACCEPT}
          onchange={onCoverChange}
          disabled={uploading}
          class="text-sm text-dark-2 file:mr-3 file:rounded-md file:border-0 file:bg-dark-4 file:px-3 file:py-1.5 file:text-sm file:text-white"
        />
        {#if uploading}<span class="text-sm text-dark-2">Uploading…</span>{/if}
      </div>
      {#if cover}
        <img
          src={cover.previewUrl}
          alt=""
          class="mt-2 h-28 w-auto rounded-lg border border-dark-4"
        />
      {:else if seed?.coverUrl}
        <p class="text-xs text-dark-2">A cover is already set. Choosing a file replaces it.</p>
      {/if}
      {#if coverError}<p class="text-sm text-red-300">{coverError}</p>{/if}
    </div>

    <div class="flex flex-col gap-1.5">
      <Label>Where it shows</Label>
      <div class="flex flex-wrap gap-2">
        {#each DOMAIN_COLORS as domain (domain)}
          <button
            type="button"
            onclick={() => toggleDomain(domain)}
            class="rounded-lg border px-3 py-1.5 text-left text-sm transition-colors {domains.includes(
              domain
            )
              ? 'border-blue-4 bg-blue-4/10 text-white'
              : 'border-dark-4 text-dark-2 hover:border-dark-3'}"
          >
            <span class="block font-medium">{DOMAIN_LABELS[domain].label}</span>
            <span class="block text-xs text-dark-2">{DOMAIN_LABELS[domain].hint}</span>
          </button>
        {/each}
      </div>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="flex flex-col gap-1.5">
        <Label for="announcement-starts">Starts</Label>
        <Input
          id="announcement-starts"
          name="startsAt"
          type="datetime-local"
          bind:value={startsAt}
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="announcement-ends">Ends</Label>
        <Input id="announcement-ends" name="endsAt" type="datetime-local" bind:value={endsAt} />
      </div>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="flex flex-col gap-1.5">
        <Label for="announcement-link">Button link (optional)</Label>
        <Input id="announcement-link" name="linkUrl" bind:value={linkUrl} placeholder="https://" />
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
      <Button type="submit" disabled={submitting || uploading || blocked}>
        {submitting ? 'Saving…' : seed ? 'Save changes' : 'Post announcement'}
      </Button>
      <Button type="button" variant="ghost" onclick={onDone}>Cancel</Button>
    </div>
  </div>
</form>
