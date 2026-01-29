import { openai } from '~/server/services/ai/openai';

const SYSTEM_PROMPT = `You are an expert prompt engineer for AI image generation, specializing in comic and webtoon panel art. Given a user's scene description, rewrite it as a detailed image generation prompt.

Rules:
- Start with the character's trigger word(s) if provided
- Describe the scene with specific visual details: pose, expression, environment, lighting
- Add compositional terms: "comic panel", "dynamic angle", "detailed background"
- Add quality terms: "high detail", "sharp focus", "professional illustration"
- Keep the output under 1500 characters total
- Do NOT add negative prompt terms — just the positive prompt
- Do NOT include any explanation, just output the enhanced prompt text`;

export async function enhanceComicPrompt(input: {
  userPrompt: string;
  characterName: string;
  trainedWords: string[];
}): Promise<string> {
  const { userPrompt, characterName, trainedWords } = input;

  // Fallback: prepend trained words to user prompt
  const fallback =
    trainedWords.length > 0 ? `${trainedWords.join(', ')}, ${userPrompt}` : userPrompt;

  if (!openai) {
    console.warn('OpenAI client not configured — skipping prompt enhancement');
    return fallback;
  }

  try {
    const userMessage = [
      characterName && `Character name: ${characterName}`,
      trainedWords.length > 0 && `Trigger words: ${trainedWords.join(', ')}`,
      `Scene: ${userPrompt}`,
    ]
      .filter(Boolean)
      .join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 512,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
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
