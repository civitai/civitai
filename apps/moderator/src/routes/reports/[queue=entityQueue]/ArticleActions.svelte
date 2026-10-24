<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { LINK_CLASS } from '$lib/format';
  import { ARTICLE_STATUS_NOTES } from '$lib/articles';
  import {
    ARTICLE_UNPUBLISH_REASONS,
    articleUnpublishReasonLabel,
  } from '$lib/article-unpublish-reasons';
  import type { ArticleRow } from '$lib/server/article-lookup.service';

  // What the article queue can do to the article itself: unpublish it as a violation, with the reason
  // its author is shown — the model queue's "Act on the model", for an article. No undo here, as there
  // is none on the model queue: republishing a violation is an appeal decision, and Unpublished
  // Articles keeps it, along with deleting one for good.
  let {
    article,
    reportId,
  }: {
    article: Pick<ArticleRow, 'id' | 'status'>;
    /** The report the unpublish is filed under — the server reads the article from it. */
    reportId: number | null;
  } = $props();

  let reason = $state('');
  const form = new FormState({ reload: true, onSuccess: () => (reason = '') });
</script>

<section aria-labelledby="article-actions-heading" class="flex flex-col gap-2">
  <div>
    <h3 id="article-actions-heading" class="m-0 text-sm font-semibold">Act on the article</h3>
    <p class="m-0 text-xs text-muted-foreground">
      This changes the article only. Rule on each report above.
    </p>
  </div>

  {#if article.status === 'Published'}
    <form
      method="POST"
      action="?/unpublishArticle"
      use:enhance={form.enhance}
      class="flex flex-col gap-2 rounded-md border p-3"
    >
      <input type="hidden" name="reportId" value={reportId ?? ''} />
      <div>
        <p class="m-0 text-sm font-medium">Unpublish as a violation</p>
        <p class="m-0 text-xs text-muted-foreground">
          Takes the article off the site and out of search. The author sees the reason on it.
        </p>
      </div>
      {#if form.error}<ErrorAlert message={form.error} />{/if}
      <!-- A hidden input rather than `Select.Root name=`, as `ImageActionBar` does: an unset reason
           must post nothing, and the primitive would post an empty string. -->
      {#if reason}<input type="hidden" name="reason" value={reason} />{/if}
      <Select.Root type="single" bind:value={() => reason, (v) => (reason = v ?? '')}>
        <Select.Trigger aria-label="Unpublish reason" class="w-full">
          {reason ? articleUnpublishReasonLabel(reason) : 'Pick a reason…'}
        </Select.Trigger>
        <Select.Content>
          {#each ARTICLE_UNPUBLISH_REASONS as r (r.value)}
            <Select.Item value={r.value}>{r.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      {#if reason}
        <!-- The site's own unpublish dialog: the message is what the author reads for Other, and an
             internal note for every other reason. -->
        <Textarea
          name="customMessage"
          rows={2}
          maxlength={1000}
          aria-label={reason === 'other' ? 'Message to the author' : 'Internal note'}
          placeholder={reason === 'other'
            ? 'Message to the author (required)'
            : 'Internal note (optional)'}
        />
      {/if}
      <Button
        type="submit"
        size="sm"
        variant="destructive"
        class="self-start"
        disabled={!reason || reportId == null || form.submitting}
      >
        {form.submitting ? 'Working…' : 'Unpublish'}
      </Button>
    </form>
  {:else}
    <p class="m-0 rounded-md border p-3 text-xs text-muted-foreground">
      {#if article.status === 'UnpublishedViolation'}
        Unpublished as a violation. Republishing is done from
        <a href="/articles/unpublished" class={LINK_CLASS}>Unpublished Articles</a>.
      {:else}
        <!-- A draft, one still processing, or the author's own unpublish: nothing is live to take down. -->
        Not live ({ARTICLE_STATUS_NOTES[article.status] ?? article.status}), so there is nothing to
        unpublish.
      {/if}
    </p>
  {/if}
</section>
