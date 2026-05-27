---
name: write-model-description
description: Draft a model description for the CivitaiOfficial account when mirroring a third-party model on civitai.com or civitai.red. Use when the user is publishing or rewriting a mirrored model page (e.g. Sulphur, HappyHorse, Wan, ACE-Step) and wants a structured, properly-credited description rather than a one-line stub. Produces HTML ready to paste into the Civitai rich-text editor.
---

# Write CivitaiOfficial Model Description

How to write a model description for the **CivitaiOfficial** account when mirroring a third-party model on civitai.com or civitai.red.

## TL;DR

A good CivitaiOfficial description:

1. Opens with a one-paragraph lede (what is it, who built it, what's the base, what's the headline capability).
2. Credits and links the **original creators** prominently, near the top.
3. Lists which **versions** are mirrored on Civitai (and which aren't).
4. Has 3-5 H3 sections with **bold labels**, each covering one capability or workflow detail.
5. Ends with a Links section (source repo, project Discord, support/funding).
6. Length: aim for **2,000-4,000 characters of HTML**. Anything under 1,000 chars is too thin.

## Why this matters

We mirror community / lab models on the CivitaiOfficial account so creators can run them on-site without local setup. That mirror only works socially if:

- The original team gets unmistakable credit at the top (not buried at the bottom).
- We link the **canonical source** (Hugging Face / GitHub / project site) so users can fork, fund, or follow updates upstream.
- We document the model honestly: which versions, which formats, known caveats.

A 1-line description (just "model based on X, link here") leaves money on the table for both the creators and our users. It also reads like we don't care.

## Required structure

Drop into the Civitai rich-text editor as HTML. The editor will preserve `<h3>`, `<strong>`, `<em>`, `<a>`, `<code>`, `<ul>`, `<ol>`.

### 1. Lede paragraph

One paragraph, ~2-3 sentences. Should answer:
- What is the model (text-to-image, video gen, audio, edit, etc.)?
- What is the base / lineage (LTX 2.3, Flux, Wan, etc.)?
- What's the standout capability or differentiator?

Keep it punchy. No hedging, no adjectives like "cutting-edge" / "state-of-the-art" unless there's a benchmark to back it.

### 2. Source attribution (right after lede)

A bold sentence pointing to the original release and explicitly handing credit upstream. Example:

> **Originally released by [TeamName](https://huggingface.co/TeamName/model) on Hugging Face.** All credit for the model goes to the TeamName team and contributors below. Civitai is hosting a mirror so creators can run it on-site - please head to the [original repo](...) for weights, updates, and to support the project directly.

### 3. "Built by" section

H3 list of every contributor named in the upstream README, with their links. Lead with the org/lead author. Include funders if they're acknowledged upstream.

### 4. Feature sections (3-5 of them)

H3 with a **bold label**, then 1-2 short paragraphs. Each covers one of:
- Native capabilities (t2v, i2v, audio sync, multi-turn, inpainting, etc.)
- Versions / variants on Civitai (which builds we mirror, which we don't)
- Workflow notes, recommended starting point, gotchas
- Add-ons (prompt enhancer, distill LoRA, control modules)
- Content posture (PG, uncensored, etc.) when relevant

### 5. Links section

H3 list with: Source (HF/GitHub), project Discord, project funding/Patreon/Ko-fi.

## Tone

- **Plainspoken.** "Sulphur 2 inherits the LTX 2.3 pipeline end to end" beats "leverages the LTX 2.3 architecture for unparalleled fidelity."
- **No marketing fluff.** Cut "revolutionary," "groundbreaking," "next-generation" unless quoted directly from the source.
- **No em dashes.** Use a hyphen (`-`) with spaces around it.
- **Hedge only when honest.** If a build isn't on Civitai, say so.

## Process

1. **Read the upstream README.** Hugging Face raw README is usually at `https://huggingface.co/<org>/<model>/raw/main/README.md`.
2. **Open 2-3 sibling CivitaiOfficial models** for tone reference (e.g. HappyHorse-1.0, Wan Video 2.7, ACE-Step). Match their structure.
3. **Confirm what's actually mirrored on Civitai.** Check the model versions on the Civitai page - if upstream ships fp8/bf16/fp16 and we only mirror fp8, say that.
4. **Draft in markdown first**, then convert to HTML for the editor.
5. **Get Justin's eyes on it before publishing** for any model that's externally significant or NSFW.

## Drafting prompt

When using this skill, the assistant should ask the user for (or be given):
- Model name + Civitai page URL (so version mirroring can be verified)
- Upstream source (Hugging Face / GitHub URL)
- Any extra notes the user wants surfaced (NSFW posture, recommended starting workflow, etc.)

Then draft using this template instruction:

> Draft a CivitaiOfficial model description for [model name] using the structure in this skill. Source README is below. Output as HTML ready to paste into the Civitai editor. Keep it 2,000-4,000 chars. No em dashes. No marketing fluff.

Then verify before returning to the user:
- Source link is the canonical upstream repo, not a re-host.
- Every contributor in the upstream README's credits section made it into "Built by."
- Version list matches what's actually on the Civitai page.

## Reference: well-structured siblings

| Model | Why it works |
|---|---|
| HappyHorse-1.0 | Clear feature H3s with bold labels, ends with "Originally posted" link |
| Wan Video 2.7 | Strong Overview + Key Improvements split, full details link |
| ACE-Step Audio Gen | Explicit Direct Use / Downstream Use sections + bullet capability list |
| OpenAI's GPT-image-1 | Top-of-page colored callout for the on-site-generation news |

## Example: Sulphur 2 Base

This model was the trigger for writing the guide this skill is based on. The original 420-char description was:

> Model Source: huggingface.co/SulphurAI/Sulphur-2-base. An uncensored video generation model based on LTX 2.3 supporting both t2v and i2v natively, as well as all of the other ltx 2.3 formats.

The rewrite (3,873 chars) is live at https://civitai.red/models/2601098/sulphur-2-base. Compare side by side to see what "good" looks like for this account.
