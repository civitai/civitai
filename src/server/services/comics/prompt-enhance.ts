import { orchestratorChatCompletion } from '~/server/services/comics/orchestrator-chat';
import { resolveReferenceMentions } from '~/server/services/comics/mention-resolver';

const SYSTEM_PROMPT = `You enhance user prompts for AI comic panel generation. The generation model receives separate reference images of the main character, so you do NOT need to describe physical appearance.

You will be given the names of characters the user referenced in their prompt. Keep those names exactly as written — the name is how the generation model identifies who to draw.

Rules:
- Do NOT describe any character's physical appearance (hair color, eye color, clothing, etc.) — reference images handle that
- Preserve character names exactly as provided — do not rename, shorten, or omit them
- Focus on: pose, expression, action, emotion, scene composition, camera angle, environment
- Keep every element the user mentioned — do not drop, replace, or reinterpret anything
- Do NOT invent or add new characters, objects, actions, or locations the user didn't mention
- ONLY reference the characters listed below — never introduce characters not in the list
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
  const allNames =
    characterNames && characterNames.length > 0
      ? characterNames
      : characterName
      ? [characterName]
      : [];
  const allRefs = allNames.map((name, i) => ({ id: i, name }));
  const { resolvedPrompt, mentionedIds } = resolveReferenceMentions({
    prompt: userPrompt,
    references: allRefs,
  });

  // Only tell the model about characters the user actually mentioned —
  // listing all project characters causes the model to inject unmentioned ones
  const mentionedSet = new Set(mentionedIds);
  const names = allRefs.filter((r) => mentionedSet.has(r.id)).map((r) => r.name);

  // Fallback: just return the resolved prompt (no trained words for NanoBanana path)
  const fallback =
    trainedWords && trainedWords.length > 0
      ? `${trainedWords.join(', ')}, ${resolvedPrompt}`
      : resolvedPrompt;

  try {
    const textParts = [
      names.length > 0 && `Characters referenced in this prompt: ${names.join(', ')}`,
      characterName && names.includes(characterName) && `Active character (has reference images): ${characterName}`,
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

    let enhanced = result.content;
    if (!enhanced) {
      console.warn('Empty response from prompt enhancement — using fallback');
      return fallback;
    }

    // Strip any @mentions the LLM hallucinated that weren't in the original prompt.
    // The LLM sometimes invents scenes with characters the user never referenced.
    const originalMentions = new Set(names.map((n) => n.toLowerCase()));
    enhanced = enhanced.replace(/@([\w\p{L}]+)/gu, (match, name) => {
      if (originalMentions.has(name.toLowerCase())) return match;
      return name; // Strip the @ prefix, keep the word
    });

    // Prepend trained words (e.g. trigger words for LoRAs) same as fallback path
    return trainedWords && trainedWords.length > 0
      ? `${trainedWords.join(', ')}, ${enhanced}`
      : enhanced;
  } catch (error) {
    console.warn('Prompt enhancement failed — using fallback:', error);
    return fallback;
  }
}
