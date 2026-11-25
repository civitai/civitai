<script lang="ts">
  import { LINK_CLASS } from '$lib/format';

  let { subject, hidden }: { subject: string; hidden: string } = $props();
</script>

<div class="space-y-2 rounded-lg border border-dark-4 bg-dark-7 p-3.5 text-sm text-dark-0">
  <p class="m-0">This {subject} is withheld from you: {hidden} are not shown here.</p>
  <a href="/images/csam" class={LINK_CLASS}>Open the CSAM image queue</a>
</div>
