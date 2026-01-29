import { openai } from '~/server/services/ai/openai';

const SYSTEM_PROMPT = `You enhance user prompts for AI comic panel generation. The generation model receives separate reference images of the main character, so you do NOT need to describe physical appearance.

Rules:
- Do NOT describe the character's physical appearance (hair color, eye color, clothing, etc.) — reference images handle that
- Focus on: pose, expression, action, emotion, scene composition, camera angle, environment
- Keep every element the user mentioned — do not drop, replace, or reinterpret anything
- Do NOT invent new characters, objects, actions, or locations the user didn't mention
- Add visual specificity to what's already there: lighting, framing, detail level
- You may add a few quality/style tags at the end (e.g. "detailed, sharp focus, comic panel")
- If a previous panel is provided (image and/or prompt), maintain visual continuity: consistent art style, lighting tone, and environment details — but only where the new scene doesn't explicitly change them
- Keep the output under 1500 characters total
- Do NOT add negative prompt terms
- Output ONLY the enhanced prompt, no explanation`;

export async function enhanceComicPrompt(input: {
  userPrompt: string;
  characterName: string;
  trainedWords?: string[];
  previousPanel?: {
    prompt: string;
    enhancedPrompt: string | null;
    imageUrl: string | null;
  };
}): Promise<string> {
  const { userPrompt, characterName, trainedWords, previousPanel } = input;

  // Fallback: just return the user prompt (no trained words for NanoBanana path)
  const fallback =
    trainedWords && trainedWords.length > 0
      ? `${trainedWords.join(', ')}, ${userPrompt}`
      : userPrompt;

  if (!openai) {
    console.warn('OpenAI client not configured — skipping prompt enhancement');
    return fallback;
  }

  try {
    const textParts = [
      characterName && `Character name: ${characterName}`,
      previousPanel &&
        `Previous panel prompt: ${previousPanel.enhancedPrompt ?? previousPanel.prompt}`,
      `New scene: ${userPrompt}`,
    ]
      .filter(Boolean)
      .join('\n');

    // Build message content — include previous panel image if available
    type ContentPart =
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail: 'low' } };
    const content: ContentPart[] = [];

    if (previousPanel?.imageUrl) {
      content.push({
        type: 'image_url',
        image_url: { url: previousPanel.imageUrl, detail: 'low' },
      });
    }
    content.push({ type: 'text', text: textParts });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 512,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    });

    const enhanced = completion.choices[0]?.message?.content?.trim();
    if (!enhanced) {
      console.warn('Empty response from prompt enhancement — using fallback');
      return fallback;
    }

    return enhanced;
  } catch (error) {
    console.warn('Prompt enhancement failed — using fallback:', error);
    return fallback;
  }
}
