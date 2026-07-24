# Generation Panel — Licensing Fee Display (Creator Program) — checklist (2026-07-22)

From the Justin + Briant walkthrough (`Downloads/transcript (2).md`, §3 "licensing fee display
review" in the generator). Refs like `T:1003` cite transcript line numbers. Owner is Briant unless
noted.

Context: the generator (`civitai.com/generate`) footer breakdown already shows a per-resource
licensing fee and which model it's for. It's live. Going forward, generations will commonly include
**multiple** resources that each carry a licensing fee, and the info popover in the breakdown must show
each of them. (`T:979–1026`)

Tags: **[bug]** fix · **[todo]** build · **[design]** mockup/decision · **[question]** open.

---

## Bug

- [ ] **[bug]** **Licensing fee missing from breakdown when a ControlNet is added** — during the demo,
  selecting Anima with a ControlNet on showed **no** licensing fee in the breakdown; it appeared once the
  ControlNet was removed. Investigate whether adding a ControlNet (or similar auxiliary resource) causes
  the licensing fee to be **omitted from the returned pricing data**. Check the "what-if" pricing data
  returned for Anima + ControlNet. (`T:986–1009`)

## Resource-card licensing fee display (model / resource pickers)

Briant previously added licensing fees to the resource cards in the generation form's model/resource
pickers, then removed them because of parent-vs-child fee confusion. Justin still wants the fee visible
on the cards — "people are going to ask for it." (`T:1018–1096`)

- [ ] **[design]** **Mockups first** — Claude to produce a few mockups of how the licensing fee could
  look on the resource cards before building. (`T:1097–1110`)
- [ ] **[design]** **Show only the resource's own fee on the card** — the fee shown for a resource
  should be the fee **that resource itself is charging**, not a conflated total. Don't make a child model
  (e.g. a Mio Mio Hara checkpoint charging 1) look "greedy" by showing the inherited Anima base fee
  (e.g. 5) as if it were theirs. (`T:1027–1058`)
- [ ] **[design]** **Display the inherited / base (ecosystem) fee separately** — the ecosystem-level or
  inherited base fee should be shown distinctly from the resource's own fee. One idea was putting the
  base fee on the **ecosystem selector**, but that breaks for **Turbo** cost and doesn't fit the planned
  **hierarchical/inheritance** licensing model (a fine-tune of a fine-tune inheriting a base fee), so the
  ecosystem selector is **not** the right home for it. (`T:1059–1091`)
- [ ] **[design]** **Layout: use a third line under the model version name** — there appears to be room
  for a third line in the card (title/version name never overflow), which is where the licensing fee(s)
  can live. (`T:1119–1135`)
- [ ] **[design]** **Small colored text, not a badge** — render fees as small colored text (more compact
  than badges), labeled — e.g. **"base fee"** and **"additional resource fee"**. Keep the card compact
  even though it will get busier. (`T:1143–1155`)
- [ ] **[design]** **Two levels max for now: parent + child** — display at most a **parent (base)
  licensing fee** and the **child (resource's own) fee**. Deeper inheritance (fine-tune of a fine-tune,
  multiple layers) is a real future case but is very edge-case now; **flatten** deeper chains into a
  single "base fee" (fractional values allowed if needed). (`T:1100–1155`)

## Multi-resource fees in the breakdown popover

- [ ] **[todo]** **Show each resource's licensing fee in the info popover** — when a generation includes
  multiple resources that carry licensing fees, list each fee (with its model) in the breakdown info
  popover, not just a single combined number. (`T:1010–1026`)

---

## Open questions (resolve before / during build)

1. **ControlNet pricing bug** — is the licensing fee actually being omitted from the returned pricing
   data when a ControlNet is added, or is it a display-only issue? Verify against the returned data.
   (`T:1003–1009`)
2. **Mockup approval** — which of the resource-card fee mockups do we ship? (base + child fee, small
   colored text, third line under the version name.) (`T:1097–1155`)
3. **Hierarchical licensing model** — the parent→child inheritance (à la HuggingFace fine-tune lineage)
   is tentative/future. Confirm the V1 flattening rule (parent + child only; flatten deeper chains into
   "base fee") is acceptable. (`T:1069–1155`)
