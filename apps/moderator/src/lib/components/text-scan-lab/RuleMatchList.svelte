<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { matchSourceLabel, matchSourceVariant, type RuleMatch } from '$lib/model-rules';

  let { matches }: { matches: RuleMatch[] } = $props();
</script>

{#if matches.length}
  <ul class="mt-2 space-y-1">
    {#each matches as match (match.ruleId)}
      <li class="text-sm text-dark-0">
        <span class="font-medium text-white">{match.subject ?? `#${match.ruleId}`}</span>
        <Badge variant={matchSourceVariant(match)} class="ml-1">{matchSourceLabel(match)}</Badge>
        {#if match.reason}
          <p class="whitespace-pre-wrap break-words text-xs text-dark-2">{match.reason}</p>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
