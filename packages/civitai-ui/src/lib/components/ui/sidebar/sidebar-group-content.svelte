<script lang="ts">
	import { cn, type WithElementRef } from "@civitai/ui/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="sidebar-group-content"
	data-sidebar="group-content"
	class={cn("text-sm w-full", className)}
	{...restProps}
>
	{@render children?.()}
</div>
