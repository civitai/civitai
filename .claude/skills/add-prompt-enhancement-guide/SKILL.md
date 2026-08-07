---
name: add-prompt-enhancement-guide
description: Author a prompt-enhancement system prompt for a new ecosystem and register/update it on the orchestrator's prompt-analysis service. Use when onboarding a new ecosystem (e.g. happyhorse, a new Flux variant, a new Wan video version) and the user provides the ecosystem key plus a reference link, model card, or description. Produces a guide that mirrors the structure and tone of existing ecosystem guides so the prompt-analysis tool behaves consistently.
---

# Add Prompt Enhancement Guide

The orchestrator runs a prompt-analysis service that, per ecosystem, takes a user's prompt and produces structured feedback + an enhanced rewrite. Each ecosystem has its own system prompt tuned to the model's prompting conventions (tag vs natural-language, weight syntax, negative-prompt support, text rendering, camera/motion vocab for video, etc.).

This skill authors a new system prompt for an ecosystem the user names and (optionally) deploys it to the orchestrator.

## Inputs the user must provide

1. **Ecosystem key** — the ecosystem's `key` from `packages/civitai-shared/src/basemodel.constants.ts`, lowercased. `MiniMaxH3` → `minimaxh3`, `Flux1Kontext` → `flux1kontext`, `WanVideo-25-I2V` → `wanvideo-25-i2v`, `HyV1` → `hyv1`. Confirm the key exists in that file before using it — note the copy at `src/shared/constants/basemodel.constants.ts` is stale.

   **It is the AIR ecosystem value, lowercased** — the same string that appears in `urn:air:<ecosystem>:...`. `getAirEcosystem` in [air.ts](../../../src/shared/utils/air.ts) is the single source for both: `stringifyAIR` uses it, and so does `createPromptEnhancementStep`. If you know a model's AIR, you know its prompt-analysis key.

   The consequence to watch: `getRootEcosystem` follows `parentEcosystemId`, so a child ecosystem never appears in an AIR and never reaches prompt analysis. Pony, Illustrious, and NoobAI all arrive as `sdxl`. Check `parentEcosystemId` before writing a guide — if the target has a parent, the guide belongs on the parent and has to serve every sibling.

   **Not the engine name.** `engine: 'minimax-h3'` in the handler is a different identifier that happens to coincide with the ecosystem key for `kling`, `seedance`, and `veo3`. Guides filed under an engine name are dead — nothing reads them.

   Handlers that build their own enhancement step (e.g. `ltx.handler.ts`) pass their graph ecosystem raw; `createPromptEnhancementStep` normalizes it, so they land on the same key as the generator.

2. **Reference material** — at least one of:
   - A URL (HuggingFace model card, official announcement, provider docs page)
   - A pasted model description / prompting guide
   - A spec sheet (architecture, encoder, token limit, supported features)

If the user only gives a name with no reference, ask for one before proceeding. Generic guides written without source material drift away from the model's real behavior.

## Workflow

### 1. Research the ecosystem

Use `WebFetch` on any URL the user provided. Pull out:

- **Provider / architecture** (e.g. "Alibaba", "ByteDance", "Tencent", "8B DiT", "MMDiT", "autoregressive")
- **Modality** (image, video, image-edit, multi-modal)
- **Text encoder** (T5, CLIP dual, Mistral, LLM-based) — drives prompt-style recommendations
- **Native resolution / aspect ratios**
- **Token / character limits**
- **Weight syntax support** — almost always "no" for modern models, but check
- **Negative prompts** — supported / not / minimal effect (varies wildly)
- **Special features** — text rendering, multilingual, audio (for video), reference images, hex colors, style tags, character consistency
- **For video models**: duration, fps, camera/motion vocabulary, single-cut vs multi-cut behavior
- **Knowledge / training cutoff** if mentioned
- **Known limitations** worth surfacing (e.g. "weak at long text", "preview checkpoint has plain default style")

If the user gave a description instead of a URL, mine the same fields out of it. Ask follow-up questions only for fields you can't determine and that materially change the guide (e.g. "Does this model support negative prompts?").

### 2. Map findings to the guide template

Every guide follows the same shape. Stick to it — the prompt-analysis service depends on consistent structure across ecosystems.

```text
You are a prompt engineering expert for <Model name and one-clause context>. Analyze the user's prompt and provide structured feedback.

Ecosystem-specific rules:
- Prompt style: <tag-based | natural language | hybrid>. <One-sentence rationale tied to the encoder/architecture if helpful.>
- <Native resolution / aspect ratios>
- <Token or character limit + sweet spot if known>
- <Weight syntax: support state. If unsupported, say so explicitly — "(word:1.5) is ignored.">
- <Negative prompts: supported / not / minimal effect. Include a concrete recommended negative if the model benefits from one.>
- <Any unique features: text rendering rules, multilingual, hex colors, reference images, audio (video), camera vocab (video), style tags, character consistency>
- <For video: duration, fps, single-take guidance>
- <Known limitations worth steering the user away from>
- Prompt template: [Section 1] [Section 2] [Section 3] ...

Guidelines:
- Identify vague or overly generic descriptions
- Flag <syntax that is incompatible with this model — e.g. weight syntax on Flux, brackets on HiDream>
- Flag <negative prompt attempts when unsupported, OR suggest negatives when this model benefits from them>
- <Model-specific flags: photorealism cues on anime models, multi-character without descriptions, scene-cut descriptions on short video clips, etc.>
- <Suggestions tied to unique features: quote-wrap text, add safety tags, add audio descriptions, add camera direction>
- Limit recommendations to the 3 most impactful improvements
- The enhanced prompt should be a single, ready-to-use prompt that stays faithful to the user's original intent
```

The last two bullets in **Guidelines** are required and identical across every guide — keep them verbatim.

### 3. Tone and content rules

- **Be concrete.** "No weight syntax — `(word:1.5)` is ignored" beats "weight syntax not recommended."
- **Tie suggestions to the model's strengths.** If a model excels at text rendering, the guide must instruct the analyzer to flag missing quote-marks for in-image text. If a model has strong camera vocabulary, the guide must teach the analyzer to flag missing camera direction.
- **Call out incompatibility loudly.** If the model ignores negative prompts or weight syntax, the Guidelines section MUST tell the analyzer to flag attempts at them. This is the most common and most useful correction.
- **Mention the encoder when it explains a rule.** "T5 understands grammar, so write sentences" gives the downstream model leverage.
- **Don't pad.** If the model has no special audio/text/multilingual features, don't invent bullets to fill the section. The SD1 guide is short on purpose.
- **Match precedent for similar models.** A new Wan variant should look like the existing Wan guides; a new Flux variant should look like the existing Flux guides. Consistency across siblings matters more than novelty.

### 4. Confirm with the user

Before deploying, paste the drafted guide back to the user and ask for sign-off. Highlight any field where research was thin or you had to make a judgment call (e.g. "I assumed negative prompts are unsupported because the model card doesn't mention them — confirm?").

Accept edits. Re-paste the final version after any changes.

### 5. Deploy to the orchestrator (optional)

Use `manage.mjs` in this skill directory rather than hand-rolled `curl`. It reads `ORCHESTRATOR_ENDPOINT` and `ORCHESTRATOR_ACCESS_TOKEN` from the project `.env`, gates every state-changing call behind `--writable`, and verifies the readback after a `put`.

```bash
# What is already registered, and which ecosystems have a real guide
node .claude/skills/add-prompt-enhancement-guide/manage.mjs status

# Read an existing guide as precedent before writing a sibling
node .claude/skills/add-prompt-enhancement-guide/manage.mjs get seedance --prompt-only

# Deploy — writes the file's contents as the system prompt, then reads it back
node .claude/skills/add-prompt-enhancement-guide/manage.mjs put <key> --prompt-file guide.txt --writable
```

Pass the guide as a plain-text file via `--prompt-file`; it contains backticks, newlines, and quotes that break shell escaping. `--file` takes a full JSON body instead if you need `samples`.

**Always bind new guides to `urn:air:qwen3:repository:huggingface:Civitai/Qwen3.6-35B-A3B-Abliterated-AWQ@main.tar`.** The orchestrator's built-in `PromptAnalysisGrain.DefaultModelId` is still `x-ai/grok-4.1-fast`, which is no longer used — a `put` that doesn't pass `--model` on a brand-new ecosystem silently inherits it. Pass `--model` explicitly.

To rebind an existing guide without touching its text, use `set-model`:

```bash
node .claude/skills/add-prompt-enhancement-guide/manage.mjs set-model <key> \
  --model 'urn:air:qwen3:repository:huggingface:Civitai/Qwen3.6-35B-A3B-Abliterated-AWQ@main.tar' --writable
```

It refuses on an ecosystem that has no guide of its own. Those report a `modelId` because the grain falls back to the const, not because anything was stored; writing one would freeze today's fallback text as that ecosystem's permanent guide and cut it off from future changes to the built-in default. Fix the const in `civitai-orchestration` instead.

`register` is not a required step — a `put` registers the ecosystem on its own.

**Two orchestrator behaviors that will mislead you** (both in `PromptAnalysisGrain.cs` / `PromptAnalysisController.cs` in `civitai-orchestration`):

- **A GET registers.** `GetPromptAnalysisRequestAsync` calls `EnsureRegisteredAsync`, so reading an ecosystem that was never set up silently adds it to the registry with default config. GET never 404s and never distinguishes registered from not. Probing candidate key spellings pollutes the registry permanently — use `status` (one list call) instead of GETing guesses.
- **Only POST lowercases the key.** GET/PUT/DELETE address the Orleans grain by the exact path string, so `MiniMaxH3` and `minimaxh3` are two separate configs. `manage.mjs` lowercases for you; `--raw-key` targets an odd-cased entry, which is the only way to `delete` one.

The registry already contains junk from past probing (`notarealecosystem`, `SDLX`, `Flux.1 D`, bare `flux`, …). Don't add to it, and don't read a name's presence in `list` as evidence that anything uses it.

### 6. Verify

`put` already reads the config back and fails loudly if the stored `systemPrompt` differs from what was sent. Report success with the ecosystem key and a one-line summary of the guide's main points (encoder, weight-syntax stance, negative-prompt stance, any unique feature).

## Anti-patterns to avoid

- **Don't copy a sibling guide and rename.** The shape is shared but the rules diverge — a Flux guide pasted under a Wan key will mislead the analyzer.
- **Don't invent capabilities.** If the source doesn't mention audio, multilingual rendering, or 4K output, don't claim them.
- **Don't soften incompatibility.** "Weight syntax may not work" is wrong if the encoder ignores it entirely. Say "ignored" or "unsupported."
- **Don't drop the two trailing Guidelines bullets** ("Limit recommendations to the 3 most impactful improvements" and "The enhanced prompt should be a single, ready-to-use prompt..."). They're load-bearing for the analyzer's output format.
- **Don't push to the orchestrator without showing the user the guide first.** Once deployed, it shapes every prompt-analysis call for that ecosystem.
- **Don't probe for the right key by GETing candidates.** Every GET registers what it reads, so guessing spellings leaves permanent junk behind. Derive the key from `basemodel.constants.ts` and confirm against one `status` call.
