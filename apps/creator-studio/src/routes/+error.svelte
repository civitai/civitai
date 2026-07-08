<script lang="ts">
  import { page } from '$app/state';
</script>

<div class="mx-auto max-w-md py-20 text-center">
  <h1 class="mb-2 text-3xl font-semibold text-white">{page.status}</h1>
  <p class="text-dark-2">{page.error?.message ?? 'Something went wrong.'}</p>
  <a href="/" class="mt-6 inline-block">Back to dashboard</a>
</div>
