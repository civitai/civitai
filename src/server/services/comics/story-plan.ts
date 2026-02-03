import { openai } from '~/server/services/ai/openai';

const SYSTEM_PROMPT = `You are a comic storyboard planner. Given an overall story or scene description, break it down into individual comic panels.

Rules:
- Choose the right number of panels (typically 4–12) based on story complexity
- Each panel should describe a single moment, action, or beat
- Focus on: action, emotion, camera angle, composition, environment
- Do NOT describe character appearance — reference images handle that
- Preserve character names exactly as provided
- Panels should flow naturally and tell a coherent visual story
- When the story has dialogue, narration, or thoughts, include them directly in the prompt as visual text elements the image generator should render (e.g. "speech bubble saying 'I won't give up!'", "narration box at top reading 'Three days earlier...'", "thought bubble: 'This can't be real...'")
- Not every panel needs text — only include speech bubbles, narration boxes, or captions where dialogue or narration serves the story
- Keep each panel description under 300 characters
- Output JSON: { "panels": [{ "prompt": "..." }, ...] }`;

export async function planChapterPanels(input: {
  storyDescription: string;
  characterNames: string[];
}): Promise<{ panels: { prompt: string }[] }> {
  if (!openai) {
    throw new Error('OpenAI client not configured — cannot plan chapter panels');
  }

  const userMessage = [
    input.characterNames.length > 0
      ? `Characters: ${input.characterNames.join(', ')}`
      : null,
    `Story: ${input.storyDescription}`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await openai.getJsonCompletion<{ panels: { prompt: string }[] }>({
    model: 'gpt-4o-mini',
    temperature: 0.7,
    max_tokens: 2048,
    retries: 2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  if (!result?.panels || !Array.isArray(result.panels) || result.panels.length === 0) {
    throw new Error('GPT returned invalid panel breakdown');
  }

  return result;
}
