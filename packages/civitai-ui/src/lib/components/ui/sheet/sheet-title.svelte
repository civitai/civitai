<script lang="ts">
	import { Dialog as SheetPrimitive } from "bits-ui";
	import { cn } from "@civitai/ui/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: SheetPrimitive.TitleProps = $props();
</script>

<SheetPrimitive.Title
	bind:ref
	data-slot="sheet-title"
	class={cn("text-foreground text-base font-medium", className)}
	{...restProps}
/>
