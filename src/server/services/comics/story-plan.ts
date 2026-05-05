import { orchestratorChatCompletion } from '~/server/services/comics/orchestrator-chat';
import { refundMultiAccountTransaction } from '~/server/services/buzz.service';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

const SYSTEM_PROMPT_BASE = `You are a comic storyboard planner. Given an overall story or scene description, break it down into individual comic panels.

Rules:
- Each panel should describe a single moment, action, or beat
- Focus on: action, emotion, camera angle, composition, environment
- Do NOT describe character appearance — reference images handle that
- Reference characters with @ prefix exactly as given (e.g., @Maya, @Dragon, @O'Brien) — preserve apostrophes, hyphens, and special characters in names. The generation system uses these to identify which reference images to include
- Panels should flow naturally and tell a coherent visual story
- When the story has dialogue, narration, or thoughts, include them directly in the prompt as visual text elements the image generator should render (e.g. "speech bubble saying 'I won't give up!'", "narration box at top reading 'Three days earlier...'", "thought bubble: 'This can't be real...'")
- Not every panel needs text — only include speech bubbles, narration boxes, or captions where dialogue or narration serves the story
- Keep each panel description under 300 characters
- Output JSON: { "panels": [{ "prompt": "..." }, ...] }`;

function buildSystemPrompt(panelCount?: number): string {
  const panelCountRule = panelCount
    ? `- Create exactly ${panelCount} panels`
    : '- Choose the right number of panels (typically 4-12) based on story complexity';
  return SYSTEM_PROMPT_BASE.replace(
    '- Each panel should describe a single moment',
    `${panelCountRule}\n- Each panel should describe a single moment`
  );
}

export async function planChapterPanels(input: {
  token: string;
  storyDescription: string;
  characterNames: string[];
  panelCount?: number;
  currencies?: BuzzSpendType[];
}): Promise<{ panels: { prompt: string }[] }> {
  const userMessage = [
    input.characterNames.length > 0
      ? `Characters: ${input.characterNames.map((n) => `@${n}`).join(', ')}`
      : null,
    `Story: ${input.storyDescription}`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await orchestratorChatCompletion({
    token: input.token,
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 2048,
    messages: [
      { role: 'system', content: buildSystemPrompt(input.panelCount) },
      { role: 'user', content: userMessage },
    ],
    currencies: input.currencies,
  });

  const parsed = parseJsonBlock<{ panels: { prompt: string }[] }>(result.content);

  if (!parsed?.panels || !Array.isArray(parsed.panels) || parsed.panels.length === 0) {
    // Refund buzz since the orchestrator charged for the completion but the output was unusable
    await refundMultiAccountTransaction({
      externalTransactionIdPrefix: result.workflowId,
      description: 'Refund for invalid panel breakdown response',
    }).catch(() => {}); // Best-effort refund — don't block the error from reaching the user
    throw new Error('LLM returned invalid panel breakdown');
  }

  // The LLM occasionally invents @CharName tokens for characters not in the
  // provided list. Strip the @ from any mention that isn't a real character so
  // the user-visible plan and downstream generation don't reference ghosts.
  //
  // Mirror `resolveReferenceMentions`'s name-matching: reference names can
  // contain spaces and punctuation (e.g. "Mary Jane", "Dr. Smith"), and the
  // boundary at the end of a mention is a punctuation/whitespace lookahead.
  // The previous regex `@([\w\p{L}'-]+)` only matched a contiguous token, so
  // `@Mary Jane` was mis-flagged as a ghost and lost its `@`.
  const sortedAllowed = [...input.characterNames].sort((a, b) => b.length - a.length);
  const stripGhostMentions = (text: string) => {
    // Pass 1: collect the start index of every `@` that begins a real
    // reference mention. Walk allowed names longest-first so
    // "Mary Jane Watson" beats "Mary"; the resolver matches the same way.
    const keepAtPositions = new Set<number>();
    for (const name of sortedAllowed) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`@${escaped}(?=$|[\\s.,!?;:\\)\\]])`, 'gi');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        keepAtPositions.add(match.index);
      }
    }
    // Pass 2: rebuild the string, dropping `@` chars that don't start a real
    // mention but DO appear to start a token. Email-like `me@example.com`
    // is left alone — the `@` there is preceded by a non-space char.
    let result = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const isGhostAt =
        ch === '@' &&
        !keepAtPositions.has(i) &&
        (i === 0 || /\s/.test(text[i - 1])) &&
        i + 1 < text.length &&
        !/\s/.test(text[i + 1]);
      if (isGhostAt) continue;
      result += ch;
    }
    return result;
  };
  parsed.panels = parsed.panels.map((p) => ({ ...p, prompt: stripGhostMentions(p.prompt) }));

  return parsed;
}

/** Extract JSON from a response that may contain markdown code fences. */
function parseJsonBlock<T>(text: string): T | null {
  if (!text) return null;

  // Try to extract from ```json ... ``` block first
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();

  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return null;
  }
}
