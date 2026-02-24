import { orchestratorChatCompletion } from '~/server/services/comics/orchestrator-chat';

const SYSTEM_PROMPT = `You are a comic storyboard planner. Given an overall story or scene description, break it down into individual comic panels.

Rules:
- Choose the right number of panels (typically 4–12) based on story complexity
- Each panel should describe a single moment, action, or beat
- Focus on: action, emotion, camera angle, composition, environment
- Do NOT describe character appearance — reference images handle that
- Reference characters with @ prefix (e.g., @Maya, @Dragon) — the generation system uses these to identify which reference images to include
- Panels should flow naturally and tell a coherent visual story
- When the story has dialogue, narration, or thoughts, include them directly in the prompt as visual text elements the image generator should render (e.g. "speech bubble saying 'I won't give up!'", "narration box at top reading 'Three days earlier...'", "thought bubble: 'This can't be real...'")
- Not every panel needs text — only include speech bubbles, narration boxes, or captions where dialogue or narration serves the story
- Keep each panel description under 300 characters
- Output JSON: { "panels": [{ "prompt": "..." }, ...] }`;

export async function planChapterPanels(input: {
  token: string;
  storyDescription: string;
  characterNames: string[];
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
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  const parsed = parseJsonBlock<{ panels: { prompt: string }[] }>(result.content);

  if (!parsed?.panels || !Array.isArray(parsed.panels) || parsed.panels.length === 0) {
    throw new Error('LLM returned invalid panel breakdown');
  }

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
