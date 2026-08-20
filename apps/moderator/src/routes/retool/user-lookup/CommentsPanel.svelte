<script lang="ts">
  import { FormState } from '$lib/form-state.svelte';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, plainText } from '$lib/format';
  import { commentV2Url, entityUrl, modelCommentUrl } from '$lib/entity-url';
  import type { Account } from './user-account';
      import ListCard from './ListCard.svelte';
  import ListFilterBar, { type FilterField } from '$lib/components/ListFilterBar.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';

  // Retool's comment search. Matched against the PLAIN text, not the stored HTML — searching the markup
  // meant "p" hit every row.
  const SEARCH: FilterField[] = [{ kind: 'search', key: 'q', label: 'Search content' }];
  let modelFilters = $state<Record<string, string>>({});
  let otherFilters = $state<Record<string, string>>({});
  const bySearch = <T extends { content: string }>(rows: T[], f: Record<string, string>) =>
    f.q ? rows.filter((r) => plainText(r.content).toLowerCase().includes(f.q.toLowerCase())) : rows;

  // Bound so each confirmation can name a count. The inputs stay in the form, so they still post.
  let selectedComments = $state<number[]>([]);
  let selectedCommentsV2 = $state<number[]>([]);

  let {
    account,
    userId,
    canAct,
    civitaiUrl,
    onSuccess,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    civitaiUrl: string;
    onSuccess: () => void;
  } = $props();

  // Called through, not captured: reading the prop inside the closure is what stops a re-passed
  // callback being ignored (svelte’s `state_referenced_locally`).
  const form = new FormState({ onSuccess: () => onSuccess() });
  const modelUrl = (modelId: number | null, commentId: number) =>
    modelId ? modelCommentUrl(civitaiUrl, modelId, commentId) : null;
  const CHECKBOX = 'accent-blue-500 mr-1';
</script>

{#if form.error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {form.error}
  </div>
{/if}

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  {#await account}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">Loading comments…</p>
    </div>
  {:then result}
    {#if result}
      {@const shown = bySearch(result.comments.items, modelFilters)}
      <ListCard title="Model comments" total={shown.length} capped={result.comments.truncated}>
        {#snippet controls()}
          <ListFilterBar
            fields={SEARCH}
            bind:values={modelFilters}
            matched={shown.length}
            total={result.comments.items.length}
          />
        {/snippet}
        {#snippet children(limit)}
          <form method="POST" action="?/contentAction" use:enhance={form.enhance}>
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="kind" value="comments" />
            <ul class="space-y-2 text-sm">
              {#each shown.slice(0, limit) as c (c.id)}
                <li>
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    {#if canAct}
                      <input
                        type="checkbox"
                        name="commentIds"
                        value={c.id}
                        bind:group={selectedComments}
                        class={CHECKBOX}
                      />
                    {/if}
                    {#if modelUrl(c.modelId, c.id)}
                      <a href={modelUrl(c.modelId, c.id)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
                        model {c.modelId}
                      </a>
                    {/if}
                    {#if c.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
                    {#if c.nsfw}<Badge variant="secondary">nsfw</Badge>{/if}
                    <span class="text-xs text-dark-2">{dateTime(c.createdAt)}</span>
                  </div>
                  <p class="line-clamp-2 text-dark-1">{plainText(c.content)}</p>
                </li>
              {/each}
            </ul>
            {#if canAct}
              <div class="mt-3 flex flex-wrap gap-2 border-t border-dark-4 pt-3">
                <ConfirmSubmit
                  label="Delete"
                  name="op"
                  value="delete"
                  count={selectedComments.length}
                  noun="comment"
                  submitting={form.submitting}
                />
                <ConfirmSubmit
                  label="Remove as ToS"
                  name="op"
                  value="tos"
                  count={selectedComments.length}
                  noun="comment"
                  submitting={form.submitting}
                />
              </div>
            {/if}
          </form>
        {/snippet}
      </ListCard>

      <!-- Retool's "Other Comments" half: image, article, bounty and post threads. -->
      {@const shownV2 = bySearch(result.commentsV2.items, otherFilters)}
      <ListCard title="Other comments" total={shownV2.length} capped={result.commentsV2.truncated}>
        {#snippet controls()}
          <ListFilterBar
            fields={SEARCH}
            bind:values={otherFilters}
            matched={shownV2.length}
            total={result.commentsV2.items.length}
          />
        {/snippet}
        {#snippet children(limit)}
          <form method="POST" action="?/contentAction" use:enhance={form.enhance}>
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="kind" value="comments" />
            <ul class="space-y-2 text-sm">
              {#each shownV2.slice(0, limit) as c (c.id)}
                <li>
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    {#if canAct}
                      <input
                        type="checkbox"
                        name="commentV2Ids"
                        value={c.id}
                        bind:group={selectedCommentsV2}
                        class={CHECKBOX}
                      />
                    {/if}
                    <!-- Always linkable, even for an entity type with no page of its own: the resolver
                         works from the comment id, so the label degrades but the link does not. -->
                    <a
                      href={commentV2Url(civitaiUrl, c.id)}
                      target="_blank"
                      rel="noreferrer"
                      class={LINK_CLASS}
                    >
                      {#if entityUrl(civitaiUrl, c.entityType, c.entityId)}
                        {c.entityType} {c.entityId}
                      {:else}
                        thread {c.threadId}
                      {/if}
                    </a>
                    {#if c.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
                    <span class="text-xs text-dark-2">{dateTime(c.createdAt)}</span>
                  </div>
                  <p class="line-clamp-2 text-dark-1">{plainText(c.content)}</p>
                </li>
              {/each}
            </ul>
            {#if canAct}
              <div class="mt-3 flex flex-wrap gap-2 border-t border-dark-4 pt-3">
                <ConfirmSubmit
                  label="Delete"
                  name="op"
                  value="delete"
                  count={selectedCommentsV2.length}
                  noun="comment"
                  submitting={form.submitting}
                />
                <ConfirmSubmit
                  label="Remove as ToS"
                  name="op"
                  value="tos"
                  count={selectedCommentsV2.length}
                  noun="comment"
                  submitting={form.submitting}
                />
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
