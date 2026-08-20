<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { BAN_REASONS } from '$lib/enforcement';
  import { num } from '$lib/format';

  let {
    userId,
    username,
    action = '?/ban',
    enhancer,
    busy = false,
    onCancel,
    prompt,
    hidden,
  }: {
    userId: number;
    username: string | null;
    action?: string;
    enhancer: SubmitFunction;
    busy?: boolean;
    onCancel: () => void;
    /** What the ban does on THIS page, beyond the shared consequences. */
    prompt?: Snippet;
    /** Extra hidden inputs the page's action needs alongside the ban fields. */
    hidden?: Snippet;
  } = $props();

  let reasonCode = $state('');
  let removeModels = $state(true);
  const uid = $props.id();

  // What this ban actually takes down. Derived so opening the form on a different account re-asks, and
  // so a slow count never blocks the form from rendering.
  const preview = $derived(
    browser
      ? fetch(`/api/ban-preview/${userId}`).then((r): Promise<{ imageCount: number; modelCount: number }> => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
      : null
  );
</script>

<form method="POST" {action} use:enhance={enhancer}>
  <!-- The SUBJECT is not posted from here. Each page supplies a key it owns (a restriction id, a model
       id, its own user id) through `hidden` and resolves the account server-side: a posted account id is
       one an edited form can change, and this action ends accounts. -->
  {@render hidden?.()}
  <div class="rounded-md border border-red-500/40 bg-red-500/10 p-3">
    <p class="mb-2 text-sm text-white">
      Ban <strong>{username ?? userId}</strong>? Unpublishes their models and notifies them. Images
      stay up unless the reason is Sexual Minor, or you tick below.
    </p>
    {@render prompt?.()}

    {#await preview}
      <p class="mb-2 text-xs text-dark-2">Counting what this would take down…</p>
    {:then counts}
      {#if counts}
        <p class="mb-2 text-sm text-dark-0">
          This account has <strong>{num(counts.modelCount)}</strong> live
          {counts.modelCount === 1 ? 'model' : 'models'} and
          <strong>{num(counts.imageCount)}</strong>
          {counts.imageCount === 1 ? 'image' : 'images'}.
        </p>
      {/if}
    {:catch}
      <p class="mb-2 text-xs text-amber-300">Could not count this account's content.</p>
    {/await}

    <Select.Root type="single" name="reasonCode" bind:value={reasonCode}>
      <Select.Trigger class="mb-2 w-full">{reasonCode || 'Reason code (optional)'}</Select.Trigger>
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
      <Checkbox id="ban-remove-media-{uid}" name="removeMedia" />
      <Label for="ban-remove-media-{uid}" class="font-normal text-dark-0">
        Also remove their images
      </Label>
    </div>
    <div class="mt-2 flex items-center gap-2">
      <Checkbox id="ban-remove-models-{uid}" name="removeModels" bind:checked={removeModels} />
      <Label for="ban-remove-models-{uid}" class="font-normal text-dark-0">
        Unpublish their models
      </Label>
    </div>
    {#if reasonCode === 'Other'}
      <p class="mt-2 text-xs text-amber-300">
        “Other” needs an internal note saying what the ban is for.
      </p>
    {/if}

    <div class="mt-2 flex gap-2">
      <Button type="submit" size="sm" variant="destructive" disabled={busy}>
        {busy ? 'Working…' : 'Confirm ban'}
      </Button>
      <Button type="button" size="sm" variant="outline" onclick={onCancel}>Cancel</Button>
    </div>
  </div>
</form>
