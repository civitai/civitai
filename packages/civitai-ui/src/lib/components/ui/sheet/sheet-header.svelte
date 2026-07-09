<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "@civitai/ui/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="sheet-header"
	class={cn("gap-0.5 p-4 flex flex-col", className)}
	{...restProps}
>
	{@render children?.()}
</div>
