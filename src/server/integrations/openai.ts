import { env } from '~/env/server.mjs';

async function moderatePrompt(prompt: string) {
  if (!env.OPENAI_TOKEN) return { flagged: false, categories: [] };
  const res = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_TOKEN}`,
    },
    body: JSON.stringify({
      input: prompt,
    }),
  });
  if (!res.ok) {
    let message = `OpenAI moderation failed: ${res.status} ${res.statusText}`;
    try {
      const body = await res.text();
      message += `\n${body}`;
    } catch (err) {}
    throw new Error(message);
  }

  const { results } = await res.json();
  let flagged = results[0].flagged;
  let categories = Object.entries(results[0].categories)
    .filter(([, v]) => v as boolean)
    .map(([k]) => k);

  // If we have categories
  // Only flag if any of them are found in the results
  if (env.OPENAI_CATEGORIES) {
    categories = categories.filter((c) => env.OPENAI_CATEGORIES?.includes(c));
    flagged = categories.length > 0;
  }

  return { flagged, categories };
}

export const openai = {
  moderatePrompt,
};
