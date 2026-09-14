<script lang="ts" generics="K">
	import type { ComponentProps } from "svelte";
	import { Checkbox } from "@civitai/ui/components/ui/checkbox/index.js";
	import {
		suppressShiftSelection,
		type SelectionSet,
	} from "@civitai/ui/hooks/selection-set.svelte.js";

	let {
		selection,
		key,
		order,
		...restProps
	}: {
		selection: SelectionSet<K>;
		key: K;
		/** The keys in the order the user sees them: the range a shift-click spans. */
		order: readonly K[];
	} & Omit<
		ComponentProps<typeof Checkbox>,
		"checked" | "indeterminate" | "onclick" | "onkeydown" | "onmousedown"
	> = $props();

	// bits-ui runs these before its own toggle (click, or Space in its keydown), so the setter sees this
	// event's shift. onclick/onkeydown must not preventDefault: bits-ui skips its toggle if they do.
	let shiftKey = false;
</script>

<!-- A function binding, not `checked=`: bits-ui writes `checked` on interaction and a plain prop
     latches on that write (docs/svelte-app-standard.md). -->
<Checkbox
	{...restProps}
	bind:checked={() => selection.has(key), () => selection.toggle(key, order, shiftKey)}
	onclick={(e: MouseEvent) => (shiftKey = e.shiftKey)}
	onkeydown={(e: KeyboardEvent) => (shiftKey = e.shiftKey)}
	onmousedown={suppressShiftSelection}
/>
