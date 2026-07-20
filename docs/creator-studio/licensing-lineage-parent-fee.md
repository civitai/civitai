# Licensing lineage & the parent-fee rule

Design record for how many licensing fees a resource owes and who receives them. Companion to
[licensing-fee-owner-stamping.md](./licensing-fee-owner-stamping.md) (which covers the owner-stamping /
earnings-read side). This doc is about **fee emission** — the product rule and its future shape.

> **Status:** the v1 rule below reflects Justin's flat-lineage answers (2026-07-14) + the "checkpoints-only
> parent fee" refinement. The one item needing an explicit ✅ from Justin is called out under *Open question*.

## Two fee concepts

When someone generates an image, each resource can owe:

- **Own fee** — the resource's own price (LoRA `0.1`, checkpoint `1`, Anima `5`).
- **Parent / ecosystem fee** — the fee owed *upstream* to the base it derives from.

A generation's total is the sum across the resources it uses; currencies never convert.

## The v1 rule — only checkpoints have a parent fee

**Only checkpoints / diffusion models carry a parent fee.** A LoRA (and embeddings, VAEs, …) owes **only its own
fee** — it's an adapter run on top of a checkpoint that already pays the ecosystem, so it doesn't also owe the
ecosystem.

| Version type | Parent (lineage) | Parent fee? | Fees emitted |
|---|---|---|---|
| Checkpoint / diffusion | its ecosystem / base | **Yes** | own + parent (≤2) |
| LoRA — *v1* | none | No | own only (≤1) |
| LoRA — *future* | **another LoRA** | Possible | own + walked ancestor chain |

## Lineage is type-consistent

A version's parent is always its own kind — never across kinds:

- A LoRA is **never** a fine-tune of a checkpoint, so a LoRA's parent is **never** a checkpoint.
- If a LoRA ever has a parent, it's a **LoRA-of-a-LoRA** (a derivative of another LoRA).
- A checkpoint's parent is its ecosystem/base.

## Why checkpoints stay flat but LoRAs could go deep

This is the consequence that shapes the eventual code:

- **Checkpoints are permanently flat.** A checkpoint has exactly one ancestor (its ecosystem) — single hop.
  Justin's "there isn't really a hierarchy" holds for checkpoints for good: ≤2 fees, no chain to walk.
- **LoRA→LoRA is genuinely recursive.** LoRA C derives from LoRA B derives from LoRA A. *That* is the one place a
  real multi-level chain — and stacked, per-ancestor fees — can appear in the future. It doesn't exist for
  checkpoints; it's the LoRA branch where it eventually could.

## The dedup non-issue

Because only the **single** base checkpoint in a generation carries the ecosystem fee, that fee is charged **once
per generation by construction** — there's no need for the orchestrator to dedup an ecosystem fee across
resources. (The dedup concern only arose under an earlier, wrong model where a LoRA *also* emitted the ecosystem
fee.)

## Implication for fee emission (mini endpoint)

*(The mini endpoint — `src/pages/api/v1/model-versions/mini/[id].ts` — is owned by briant; this is design intent,
not a prescriptive diff.)*

- **Gate the parent-fee resolution to checkpoint / diffusion model types**, so a LoRA never emits a parent fee
  today, even if data (a `licensingSourceVersionId`, etc.) would otherwise resolve one. The disabled paths for
  non-checkpoints are the rule; don't rely on the absence of data.
- **The `fees[]` shape is already forward-compatible.** Each entry carries its own `recipientUserId`, so the array
  can grow from "own + one parent" to "own + N walked ancestors" with no contract change for the orchestrator
  (which iterates `fees[]`) or the earnings read side. When LoRA lineage lands, the emitter walks the LoRA's parent
  chain and pushes one entry per ancestor; **lifting the gate is a relaxation plus that walk**, not a redesign.

## Read side (Creator Studio) — unaffected

Per-model earnings read whatever `resourceCompensations` rows exist, grouped by owner. Fee-count and charge rules
change the underlying numbers, never the read feature — so this whole question is orthogonal to the shipped
dashboard tile / analytics table.

## Open question for Justin

1. Confirm **"for now, only checkpoints/diffusion carry a parent fee"** as the rule to encode (LoRAs = own fee
   only). Stated as decided; needs an explicit ✅ before it's gated in code.
2. When LoRA parent fees eventually open up, confirm the intent is a **LoRA→LoRA walked chain** that stacks one fee
   per ancestor (matching the forward-compatible `fees[]` shape above).
