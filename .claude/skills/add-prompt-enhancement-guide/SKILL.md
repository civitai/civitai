---
name: add-prompt-enhancement-guide
description: Author a prompt-enhancement system prompt for a new ecosystem and register/update it on the orchestrator's prompt-analysis service. Use when onboarding a new ecosystem (e.g. happyhorse, a new Flux variant, a new Wan video version) and the user provides the ecosystem key plus a reference link, model card, or description. Produces a guide that mirrors the structure and tone of existing ecosystem guides so the prompt-analysis tool behaves consistently.
---

# Add Prompt Enhancement Guide

The orchestrator runs a prompt-analysis service that, per ecosystem, takes a user's prompt and produces structured feedback + an enhanced rewrite. Each ecosystem has its own system prompt tuned to the model's prompting conventions (tag vs natural-language, weight syntax, negative-prompt support, text rendering, camera/motion vocab for video, etc.).

This skill authors a new system prompt for an ecosystem the user names and (optionally) deploys it to the orchestrator.

## Inputs the user must provide

1. **Ecosystem key** — the lowercase identifier matching what the orchestrator returns and what the codebase uses for that ecosystem (e.g. `happyhorse`, `flux2`, `wanvideo-25-i2v`). If unsure, ask the user; do not guess.
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

```
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

If the user wants the guide pushed live, use the orchestrator manager API. Two env vars are required:

- `ORCHESTRATOR_ENDPOINT` — base URL of the orchestrator manager
- `ORCHESTRATOR_ACCESS_TOKEN` — bearer token with manager scope

Endpoints:

- `GET /v1/manager/prompt-analysis/{ecosystem}` — check whether the ecosystem is already registered. 404 means it isn't.
- `POST /v1/manager/prompt-analysis` with body `{ "ecosystem": "<key>" }` — register a new ecosystem. Expect 204.
- `PUT /v1/manager/prompt-analysis/{ecosystem}` with body `{ "systemPrompt": "<full guide>", "modelId": "<analysis-model-id>", "samples": [] }` — set or replace the guide. Expect 204.

Default `modelId` for new guides is `x-ai/grok-4.1-fast` unless the user specifies otherwise. Ask if you're not sure which analysis model to bind.

A minimal one-shot deployment via `curl`:

```bash
# Register if not present (ignore 409/204 — both are fine)
curl -sS -X POST "$ORCHESTRATOR_ENDPOINT/v1/manager/prompt-analysis" \
  -H "Authorization: Bearer $ORCHESTRATOR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ecosystem":"<key>"}'

# Update the system prompt
curl -sS -X PUT "$ORCHESTRATOR_ENDPOINT/v1/manager/prompt-analysis/<key>" \
  -H "Authorization: Bearer $ORCHESTRATOR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @body.json
```

Where `body.json` is `{ "systemPrompt": "...", "modelId": "x-ai/grok-4.1-fast", "samples": [] }`. Use a file rather than inline JSON because the system prompt contains backticks, newlines, and quotes that break shell escaping.

If the user prefers Node/PowerShell, the same three calls work — register → PUT — and the response codes are the same.

### 6. Verify

After deploy, GET the ecosystem back and confirm the `systemPrompt` returned matches what was sent. Report success with the ecosystem key and a one-line summary of the guide's main points (encoder, weight-syntax stance, negative-prompt stance, any unique feature).

## Anti-patterns to avoid

- **Don't copy a sibling guide and rename.** The shape is shared but the rules diverge — a Flux guide pasted under a Wan key will mislead the analyzer.
- **Don't invent capabilities.** If the source doesn't mention audio, multilingual rendering, or 4K output, don't claim them.
- **Don't soften incompatibility.** "Weight syntax may not work" is wrong if the encoder ignores it entirely. Say "ignored" or "unsupported."
- **Don't drop the two trailing Guidelines bullets** ("Limit recommendations to the 3 most impactful improvements" and "The enhanced prompt should be a single, ready-to-use prompt..."). They're load-bearing for the analyzer's output format.
- **Don't push to the orchestrator without showing the user the guide first.** Once deployed, it shapes every prompt-analysis call for that ecosystem.
