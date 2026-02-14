import { orchestratorChatCompletion } from '~/server/services/comics/orchestrator-chat';
import { resolveReferenceMentions } from '~/server/services/comics/mention-resolver';

const SYSTEM_PROMPT = `You enhance user prompts for AI comic panel generation. The generation model receives separate reference images of the main character, so you do NOT need to describe physical appearance.

You will be given the names of all characters in the project. When the user mentions a character by name, keep that name in the enhanced prompt exactly as written — the name is how the generation model identifies who to draw.

Rules:
- Do NOT describe any character's physical appearance (hair color, eye color, clothing, etc.) — reference images handle that
- Preserve character names exactly as provided — do not rename, shorten, or omit them
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
  token: string;
  userPrompt: string;
  characterName: string;
  characterNames?: string[];
  trainedWords?: string[];
  previousPanel?: {
    prompt: string;
    enhancedPrompt: string | null;
    imageUrl: string | null;
  };
  storyContext?: {
    storyDescription: string;
    previousPanelPrompts: string[];
  };
}): Promise<string> {
  const {
    token,
    userPrompt,
    characterName,
    characterNames,
    trainedWords,
    previousPanel,
    storyContext,
  } = input;

  // Resolve @mentions: replace @ReferenceName with the exact name
  const names =
    characterNames && characterNames.length > 0
      ? characterNames
      : characterName
      ? [characterName]
      : [];
  const { resolvedPrompt } = resolveReferenceMentions({
    prompt: userPrompt,
    references: names.map((name, i) => ({ id: i, name })),
  });

  // Fallback: just return the resolved prompt (no trained words for NanoBanana path)
  const fallback =
    trainedWords && trainedWords.length > 0
      ? `${trainedWords.join(', ')}, ${resolvedPrompt}`
      : resolvedPrompt;

  try {
    const textParts = [
      `Characters in this project: ${names.join(', ')}`,
      characterName && `Active character (has reference images): ${characterName}`,
      storyContext && `Overall story: ${storyContext.storyDescription}`,
      storyContext &&
        storyContext.previousPanelPrompts.length > 0 &&
        `Previous panels in this chapter:\n${storyContext.previousPanelPrompts
          .map((p, i) => `  Panel ${i + 1}: ${p}`)
          .join('\n')}`,
      !storyContext &&
        previousPanel &&
        `Previous panel prompt: ${previousPanel.enhancedPrompt ?? previousPanel.prompt}`,
      `New scene (panel ${
        storyContext ? storyContext.previousPanelPrompts.length + 1 : 'next'
      }): ${resolvedPrompt}`,
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

    const result = await orchestratorChatCompletion({
      token,
      model: 'gpt-4o-mini',
      temperature: 0.4,
      maxTokens: 512,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    });

    const enhanced = result.content;
    if (!enhanced) {
      console.warn('Empty response from prompt enhancement — using fallback');
      return fallback;
    }

    // Prepend trained words (e.g. trigger words for LoRAs) same as fallback path
    return trainedWords && trainedWords.length > 0
      ? `${trainedWords.join(', ')}, ${enhanced}`
      : enhanced;
  } catch (error) {
    console.warn('Prompt enhancement failed — using fallback:', error);
    return fallback;
  }
}
