<script lang="ts" module>
	export type MultiComboboxOption = { value: string; label: string; disabled?: boolean };
</script>

<script lang="ts">
	import XIcon from "@lucide/svelte/icons/x";
	import { Badge } from "@civitai/ui/components/ui/badge/index.js";
	import { cn } from "@civitai/ui/utils.js";

	let {
		options = [],
		value = $bindable([]),
		open = $bindable(false),
		placeholder = "Select...",
		emptyText = "No results found.",
		disabled = false,
		class: className,
		contentClass,
		onValueChange,
	}: {
		options: MultiComboboxOption[];
		value?: string[];
		open?: boolean;
		placeholder?: string;
		emptyText?: string;
		disabled?: boolean;
		class?: string;
		contentClass?: string;
		onValueChange?: (value: string[]) => void;
	} = $props();

	let search = $state("");
	let highlighted = $state(0);
	let rootRef = $state<HTMLDivElement>(null!);
	let inputRef = $state<HTMLInputElement>(null!);

	const selected = $derived(options.filter((o) => value.includes(o.value)));
	const filtered = $derived(
		options.filter(
			(o) => !value.includes(o.value) && o.label.toLowerCase().includes(search.trim().toLowerCase())
		)
	);

	const uid = $props.id();
	const listId = `${uid}-list`;
	const activeId = $derived(open && filtered.length ? `${uid}-opt-${highlighted}` : undefined);

	// Keep the keyboard highlight within the (shrinking) filtered list.
	$effect(() => {
		if (highlighted > filtered.length - 1) highlighted = Math.max(0, filtered.length - 1);
	});

	// Close on an outside pointer press.
	$effect(() => {
		if (!open) return;
		const onPointer = (e: PointerEvent) => {
			if (rootRef && !rootRef.contains(e.target as Node)) open = false;
		};
		document.addEventListener("pointerdown", onPointer, true);
		return () => document.removeEventListener("pointerdown", onPointer, true);
	});

	function commit(next: string[]) {
		value = next;
		onValueChange?.(next);
	}
	function add(v: string) {
		if (!value.includes(v)) commit([...value, v]);
		search = "";
		highlighted = 0;
		inputRef?.focus();
	}
	function remove(v: string) {
		commit(value.filter((x) => x !== v));
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Backspace" && search === "" && value.length > 0) {
			remove(value[value.length - 1]);
		} else if (e.key === "Escape") {
			open = false;
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			open = true;
			highlighted = Math.min(highlighted + 1, filtered.length - 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			highlighted = Math.max(highlighted - 1, 0);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const opt = filtered[highlighted];
			if (opt && !opt.disabled) add(opt.value);
		}
	}
</script>

<div bind:this={rootRef} class={cn("relative", className)}>
	<div
		class={cn(
			"flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-xs",
			"focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
			disabled && "pointer-events-none opacity-50"
		)}
	>
		{#each selected as opt (opt.value)}
			<Badge variant="secondary" class="gap-1 pr-1">
				{opt.label}
				<button
					type="button"
					aria-label={`Remove ${opt.label}`}
					class="rounded-full outline-none hover:text-foreground/70"
					onclick={(e) => {
						e.stopPropagation();
						remove(opt.value);
					}}
				>
					<XIcon class="size-3" />
				</button>
			</Badge>
		{/each}
		<input
			bind:this={inputRef}
			bind:value={search}
			{disabled}
			{placeholder}
			role="combobox"
			aria-expanded={open}
			aria-controls={listId}
			aria-activedescendant={activeId}
			aria-autocomplete="list"
			class="min-w-16 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
			onfocus={() => (open = true)}
			onkeydown={onKeydown}
		/>
	</div>

	{#if open}
		<div
			id={listId}
			role="listbox"
			class={cn(
				"absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
				contentClass
			)}
		>
			{#each filtered as opt, i (opt.value)}
				<button
					type="button"
					id={`${uid}-opt-${i}`}
					role="option"
					aria-selected={i === highlighted}
					disabled={opt.disabled}
					class={cn(
						"flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none",
						i === highlighted
							? "bg-accent text-accent-foreground"
							: "hover:bg-accent hover:text-accent-foreground",
						opt.disabled && "pointer-events-none opacity-50"
					)}
					onpointerdown={(e) => e.preventDefault()}
					onpointerenter={() => (highlighted = i)}
					onclick={() => add(opt.value)}
				>
					{opt.label}
				</button>
			{:else}
				<div class="px-2 py-1.5 text-sm text-muted-foreground">{emptyText}</div>
			{/each}
		</div>
	{/if}
</div>
