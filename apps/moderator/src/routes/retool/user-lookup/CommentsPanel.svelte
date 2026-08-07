<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { entityUrl } from '$lib/entity-url';
  import type { Account } from './user-account';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { FormResult } from './form-result';
  import ListCard from './ListCard.svelte';

  let {
    account,
    userId,
    canAct,
    form,
    civitaiUrl,
    onSubmit,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    form: FormResult;
    civitaiUrl: string;
    onSubmit: SubmitFunction;
  } = $props();

  const error = $derived(form?.scope === 'content' ? form.error : null);
  const modelUrl = (modelId: number | null) => (modelId ? `${civitaiUrl}/models/${modelId}` : null);
  const CHECKBOX = 'accent-blue-500 mr-1';
</script>

{#if error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {error}
  </div>
{/if}

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  {#await account}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">Loading comments…</p>
    </div>
  {:then result}
    {#if result}
      <ListCard title="Model comments" total={result.comments.length}>
        {#snippet children(limit)}
          <form method="POST" action="?/contentAction" use:enhance={onSubmit}>
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="kind" value="comments" />
            <ul class="space-y-2 text-sm">
              {#each result.comments.slice(0, limit) as c (c.id)}
                <li>
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    {#if canAct}
                      <input type="checkbox" name="commentIds" value={c.id} class={CHECKBOX} />
                    {/if}
                    {#if modelUrl(c.modelId)}
                      <a href={modelUrl(c.modelId)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
                        model {c.modelId}
                      </a>
                    {/if}
                    {#if c.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
                    {#if c.nsfw}<Badge variant="secondary">nsfw</Badge>{/if}
                    <span class="text-xs text-dark-2">{dateTime(c.createdAt)}</span>
                  </div>
                  <p class="line-clamp-2 text-dark-1">{c.content}</p>
                </li>
              {/each}
            </ul>
            {#if canAct}
              <div class="mt-3 flex flex-wrap gap-2 border-t border-dark-4 pt-3">
                <Button type="submit" name="op" value="delete" size="sm" variant="destructive">
                  Delete selected
                </Button>
                <Button type="submit" name="op" value="tos" size="sm" variant="destructive">
                  Remove as ToS
                </Button>
              </div>
            {/if}
          </form>
        {/snippet}
      </ListCard>

      <!-- Retool's "Other Comments" half: image, article, bounty and post threads. -->
      <ListCard title="Other comments" total={result.commentsV2.length}>
        {#snippet children(limit)}
          <form method="POST" action="?/contentAction" use:enhance={onSubmit}>
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="kind" value="comments" />
            <ul class="space-y-2 text-sm">
              {#each result.commentsV2.slice(0, limit) as c (c.id)}
                <li>
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    {#if canAct}
                      <input type="checkbox" name="commentV2Ids" value={c.id} class={CHECKBOX} />
                    {/if}
                    {#if entityUrl(civitaiUrl, c.entityType, c.entityId)}
                      <a
                        href={entityUrl(civitaiUrl, c.entityType, c.entityId)}
                        target="_blank"
                        rel="noreferrer"
                        class={LINK_CLASS}
                      >
                        {c.entityType} {c.entityId}
                      </a>
                    {:else}
                      <span class="text-xs text-dark-2">thread {c.threadId}</span>
                    {/if}
                    {#if c.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
                    <span class="text-xs text-dark-2">{dateTime(c.createdAt)}</span>
                  </div>
                  <p class="line-clamp-2 text-dark-1">{c.content}</p>
                </li>
              {/each}
            </ul>
            {#if canAct}
              <div class="mt-3 flex flex-wrap gap-2 border-t border-dark-4 pt-3">
                <Button type="submit" name="op" value="delete" size="sm" variant="destructive">
                  Delete selected
                </Button>
                <Button type="submit" name="op" value="tos" size="sm" variant="destructive">
                  Remove as ToS
                </Button>
              </div>
            {/if}
          </form>
        {/snippet}
      </ListCard>
    {/if}
  {:catch}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-red-300">Could not load comments.</p>
    </div>
  {/await}
</section>
