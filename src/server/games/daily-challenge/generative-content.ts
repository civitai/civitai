import type {
  ChallengePrompts,
  JudgingConfig,
  Prize,
  Score,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { logToAxiom } from '~/server/logging/client';
import { civitaiLLM } from '~/server/services/ai/civitai-llm';
import { openrouter, AI_MODELS, type AIModel } from '~/server/services/ai/openrouter';
import type { SimpleMessage } from '~/server/services/ai/openrouter';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import {
  DEFAULT_CATEGORY_ROWS,
  sanitizeCategoryLabel,
} from '~/shared/constants/challenge.constants';
import { resolveRubricBlock } from '~/server/services/challenge-category.service';
import { findLastIndex } from '~/utils/array-helpers';
import { markdownToHtml } from '~/utils/markdown-helpers';
import { stripLeadingWhitespace } from '~/utils/string-helpers';
import {
  parseReviewTemplate,
  resolveTemplate,
  type ReviewTemplateVariables,
} from './template-engine';

// Default models for the daily-challenge pipeline. Routed through OpenRouter.
//
// Split rationale:
//   - Content + winner selection use warm, varied creative output → GPT-4o Mini.
//   - Image review needs critical scoring that doesn't inflate; GPT-5 Nano
//     runs stricter in practice → GPT-5 Nano.
//
// To experiment with a Civitai-hosted model (e.g. Qwen via the orchestrator),
// pass the URN as `input.model` from the call site or the Playground; the
// `pickClient` dispatcher routes `urn:air:*` to the civitai-llm client.
const DEFAULT_CONTENT_MODEL: AIModel = AI_MODELS.GPT_4O_MINI;
const DEFAULT_REVIEW_MODEL: AIModel = AI_MODELS.GPT_5_NANO;

// URN-prefixed models go through the orchestrator's OpenAI-compatible endpoint
// (Civitai-hosted Qwen, etc.). Everything else (openai/*, anthropic/*, x-ai/*,
// moonshotai/*, stepfun/*) stays on OpenRouter.
function pickClient(model: string) {
  if (model.startsWith('urn:air:')) {
    if (!civitaiLLM) throw new Error('Civitai LLM not connected');
    return civitaiLLM;
  }
  if (!openrouter) throw new Error('OpenRouter not connected');
  return openrouter;
}

type GenerateCollectionDetailsInput = {
  resource: {
    modelId: number;
    title: string;
    creator: string;
  };
  image: {
    id: number;
    url: string;
  };
  config: JudgingConfig;
  model?: AIModel;
};
type CollectionDetails = {
  name: string;
  description: string;
};
export async function generateCollectionDetails(input: GenerateCollectionDetailsInput) {
  const model = input.model ?? DEFAULT_CONTENT_MODEL;
  const results = await pickClient(model).getJsonCompletion<CollectionDetails>({
    retries: 3,
    model,
    messages: [
      prepareSystemMessage(
        input.config,
        'collection',
        `{
          "name": "title of the collection",
          "description": "short single sentence description of the collection"
        }`
      ),
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: `Resource title: ${input.resource.title}\nCreator: ${input.resource.creator}`,
          },
          {
            type: 'image_url' as const,
            image_url: {
              url: input.image.url,
            },
          },
        ],
      },
    ],
  });

  return results;
}

type GenerateArticleInput = {
  resource: {
    modelId: number;
    title: string;
    creator: string;
  };
  image: {
    id: number;
    url: string;
  };
  challengeDate: Date;
  prizes: Array<Prize>;
  entryPrizeRequirement: number;
  entryPrize: Prize;
  allowedNsfwLevel: number;
  config: JudgingConfig;
  model?: AIModel;
};
type GeneratedArticle = {
  title: string;
  body: string;
  invitation: string;
  theme: string;
  themeElements: string[];
};
export async function generateArticle({ resource, image, config, model }: GenerateArticleInput) {
  const userText = `Resource title: ${resource.title}\nResource link: https://civitai.com/models/${resource.modelId}\nCreator: ${resource.creator}\nCreator link: https://civitai.com/user/${resource.creator}`;

  const selectedModel = model ?? DEFAULT_CONTENT_MODEL;
  const result = await pickClient(selectedModel).getJsonCompletion<GeneratedArticle>({
    retries: 3,
    model: selectedModel,
    messages: [
      prepareSystemMessage(
        config,
        'content',
        `{
          "title": "title of the challenge/article",
          "invitation": "a single sentence invitation to participate in the challenge displayed in the on-site generator",
          "body": "the content of the article in markdown",
          "theme": "a 1-2 word theme for the challenge",
          "themeElements": ["5-8 short phrases describing visual elements, colors, moods, objects, or textures expected in images matching this theme — used to anchor judging"]
        }`
      ),
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: userText,
          },
          {
            type: 'image_url' as const,
            image_url: {
              url: image.url,
            },
          },
        ],
      },
    ],
  });

  const markdownContent = stripLeadingWhitespace(`
    ${result.body}
  `);
  const content = await markdownToHtml(markdownContent);

  return {
    title: result.title,
    content,
    invitation: result.invitation,
    theme: result.theme,
    themeElements: result.themeElements ?? [],
  };
}

type GenerateThemeElementsInput = {
  theme: string;
  config: JudgingConfig;
  model?: AIModel;
};
export async function generateThemeElements(input: GenerateThemeElementsInput): Promise<string[]> {
  try {
    const model = input.model ?? DEFAULT_CONTENT_MODEL;
    const result = await pickClient(model).getJsonCompletion<{ themeElements: string[] }>({
      retries: 3,
      model,
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: `${input.config.prompts.systemMessage}\n\nGenerate 5-8 keywords (single words or short 2-3 word combinations) describing the concrete visual elements, colors, moods, objects, or textures expected in images matching a given theme. These will be used to anchor consistent judging of challenge entries. Keep them broad enough to allow creative interpretation.\n\nReply with json\n\n{"themeElements": ["keyword1", "keyword2", ...]}`,
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: `Theme: ${input.theme}` }],
        },
      ],
    });

    return result.themeElements ?? [];
  } catch (e) {
    const err = e as Error;
    logToAxiom({
      type: 'warn',
      name: 'generate-theme-elements',
      message: `Failed to generate theme elements for theme "${input.theme}": ${err.message}`,
    });
    return [];
  }
}

type GenerateReviewInput = {
  theme: string;
  themeElements?: string[];
  creator: string;
  imageUrl: string;
  config: JudgingConfig;
  model?: AIModel;
  // Creator/mod-defined judging categories. When present the review JSON schema is built from
  // these instead of the fixed theme/wittiness/humor/aesthetic set, and `key` selects each
  // category's rich scoring rubric for `{{SCORING_RUBRICS}}` injection (resolveRubricBlock).
  categories?: { key: string; name: string; criteria: string }[];
  // Selects NSFW rubric variants (ChallengeCategory.rubricNsfw, falling back to the SFW rubric).
  nsfw?: boolean;
};
type GeneratedReview = {
  score: Score;
  reaction: ReviewReactions;
  comment: string;
  summary: string;
  aestheticFlaws?: string[];
};

export const RESPONSE_SCHEMA = `{
  "score": {
    "theme": number,     // 0-10
    "wittiness": number, // 0-10
    "humor": number,     // 0-10
    "aesthetic": number  // 0-10
  },
  "reaction": "Laugh" | "Heart" | "Like" | "Cry",
  "comment": "your review comment (2-3 sentences)",
  "summary": "concise factual summary of the image",
  "aestheticFlaws": ["string describing flaw 1","string describing flaw 2",...] // optional array of strings describing specific aesthetic flaws in the image
}`;

/**
 * Build the review response schema for a user-created challenge from its creator-defined
 * judging categories. Each category becomes a 0-10 score key. Category names/criteria are
 * sanitized for inclusion in the JSON-schema string (quotes/newlines stripped).
 */
export function buildCategoryReviewSchema(
  categories: { name: string; criteria: string }[]
): string {
  const sanitizeCriteria = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  const scoreLines = categories
    .map((c) => `    "${sanitizeCategoryLabel(c.name)}": number // 0-10, ${sanitizeCriteria(c.criteria)}`)
    .join('\n');
  return `{
  "score": {
${scoreLines}
  },
  "reaction": "Laugh" | "Heart" | "Like" | "Cry",
  "comment": "your review comment (2-3 sentences)",
  "summary": "concise factual summary of the image",
  "aestheticFlaws": ["string describing flaw 1","string describing flaw 2",...] // optional array of strings describing specific aesthetic flaws in the image
}`;
}

export async function generateReview(input: GenerateReviewInput): Promise<GeneratedReview> {
  // Resolve the rubric block up front (it needs the DB-backed category library): the REAL
  // categories when present, else the canonical defaults so a migrated prompt with no categories
  // still gets the default blocks instead of a literal {{SCORING_RUBRICS}}. injectRubrics is a
  // no-op when the sentinel is absent, so unmigrated prompts stay byte-identical.
  const effectiveCategories = input.categories?.length
    ? input.categories
    : DEFAULT_CATEGORY_ROWS.map((c) => ({ key: c.key, name: c.label, criteria: c.criteria }));
  const rubricBlock = await resolveRubricBlock(effectiveCategories, { nsfw: input.nsfw });

  let messages: SimpleMessage[];
  if (input.config.reviewTemplate && !input.categories?.length) {
    try {
      messages = buildMessagesFromTemplate(input);
    } catch (e) {
      console.warn('[generateReview] Invalid reviewTemplate, falling back to default prompts:', e);
      messages = buildFallbackMessages(input, rubricBlock);
    }
  } else {
    messages = buildFallbackMessages(input, rubricBlock);
  }

  const model = input.model ?? DEFAULT_REVIEW_MODEL;
  const result = await pickClient(model).getJsonCompletion<GeneratedReview>({
    retries: 3,
    model,
    messages,
  });

  return {
    score: result.score,
    reaction: result.reaction,
    comment: result.comment,
    summary: result.summary,
    aestheticFlaws: result.aestheticFlaws,
  };
}

/**
 * Build messages from a JSON review template with variable substitution.
 */
function buildMessagesFromTemplate(input: GenerateReviewInput): SimpleMessage[] {
  const template = parseReviewTemplate(input.config.reviewTemplate!);

  const variables: ReviewTemplateVariables = {
    systemPrompt: input.config.prompts.systemMessage,
    reviewPrompt: input.config.prompts.review,
    theme: input.theme,
    themeElements: input.themeElements?.join(', ') ?? '',
  };

  const messages = resolveTemplate(template, variables);

  // Inject response schema into the last system message
  const schemaInstruction = `\n\nReply with json\n\n${stripLeadingWhitespace(RESPONSE_SCHEMA)}`;
  const lastSystemIdx = findLastIndex(messages, (m) => m.role === 'system');
  if (lastSystemIdx >= 0) {
    const msg = messages[lastSystemIdx];
    if (typeof msg.content === 'string') {
      messages[lastSystemIdx] = { ...msg, content: msg.content + schemaInstruction };
    } else if (Array.isArray(msg.content)) {
      const lastTextIdx = findLastIndex(msg.content, (item) => item.type === 'text');
      if (lastTextIdx >= 0) {
        const items = [...msg.content];
        const textItem = items[lastTextIdx] as { type: 'text'; text: string };
        items[lastTextIdx] = { type: 'text', text: textItem.text + schemaInstruction };
        messages[lastSystemIdx] = { ...msg, content: items };
      } else {
        const items = [...msg.content];
        items.push({ type: 'text', text: schemaInstruction.trimStart() });
        messages[lastSystemIdx] = { ...msg, content: items };
      }
    }
  } else {
    // No system message in template — prepend one
    messages.unshift({ role: 'system', content: schemaInstruction.trimStart() });
  }

  // Append user message with theme, creator, and image
  const themeElementsLine = formatThemeElementsLine(input.themeElements);
  messages.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Theme: ${input.theme}${themeElementsLine}\nCreator: ${input.creator}`,
      },
      { type: 'image_url', image_url: { url: input.imageUrl } },
    ],
  });

  return messages;
}

/** Sentinel in a judge's `reviewPrompt` marking where per-category scoring rubrics are injected. */
const SCORING_RUBRICS_SENTINEL = '{{SCORING_RUBRICS}}';

/**
 * Replace the `{{SCORING_RUBRICS}}` sentinel in a review prompt with the pre-resolved rubric
 * block (resolveRubricBlock). If the sentinel is absent the prompt is returned unchanged (byte
 * for byte), so unmigrated judge prompts are unaffected.
 */
export function injectRubrics(reviewPrompt: string, rubricBlock: string): string {
  if (!reviewPrompt.includes(SCORING_RUBRICS_SENTINEL)) return reviewPrompt;
  return reviewPrompt.split(SCORING_RUBRICS_SENTINEL).join(rubricBlock);
}

/**
 * Build simple 2-message array from systemPrompt + reviewPrompt fields (fallback path).
 */
export function buildFallbackMessages(
  input: GenerateReviewInput,
  rubricBlock: string
): SimpleMessage[] {
  const themeElementsLine = formatThemeElementsLine(input.themeElements);
  const userText = `Theme: ${input.theme}${themeElementsLine}\nCreator: ${input.creator}`;
  // Response schema keys on the REAL categories: a null/empty-category challenge keeps the fixed
  // RESPONSE_SCHEMA (lowercase theme/wittiness/humor/aesthetic). The rubric block was resolved by
  // the caller (generateReview) — defaults included — so sentinel replacement never leaves a
  // literal {{SCORING_RUBRICS}} behind.
  const responseSchema = input.categories?.length
    ? buildCategoryReviewSchema(input.categories)
    : RESPONSE_SCHEMA;
  const reviewText = injectRubrics(input.config.prompts.review, rubricBlock);

  return [
    prepareSystemMessage(input.config, 'review', responseSchema, reviewText),
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: userText },
        { type: 'image_url' as const, image_url: { url: input.imageUrl } },
      ],
    },
  ];
}

type GenerateWinnersInput = {
  entries: Array<{
    creatorId: number;
    creator: string;
    summary: string;
    score: Score;
  }>;
  theme: string;
  config: JudgingConfig;
  model?: AIModel;
};
type GeneratedWinners = {
  winners: Array<{
    creatorId: number;
    creator: string;
    reason: string;
  }>;
  process: string;
  outcome: string;
};
export async function generateWinners(input: GenerateWinnersInput) {
  const userText = `Theme: ${input.theme}\nEntries:\n\`\`\`json \n${JSON.stringify(
    input.entries,
    null,
    2
  )}\n\`\`\``;

  const model = input.model ?? DEFAULT_CONTENT_MODEL;
  const result = await pickClient(model).getJsonCompletion<GeneratedWinners>({
    retries: 3,
    model,
    messages: [
      prepareSystemMessage(
        input.config,
        'winner',
        `{
          "winners": [
            {"creatorId": <id from entries>, "creator": "<name from entries>", "reason": "<why they won 1st place>"},
            {"creatorId": <id from entries>, "creator": "<name from entries>", "reason": "<why they won 2nd place>"},
            {"creatorId": <id from entries>, "creator": "<name from entries>", "reason": "<why they won 3rd place>"}
          ],
          "process": "<about your judging process and the challenge as markdown>",
          "outcome": "<summary about the outcome of the challenge as markdown>"
        }
        IMPORTANT: Select exactly 3 different winners (1st, 2nd, 3rd place) using creatorId and creator values from the entries provided.`
      ),
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: userText,
          },
        ],
      },
    ],
  });

  return result;
}

// Helpers
// ------------------------------------

function formatThemeElementsLine(themeElements?: string[]): string {
  if (!themeElements?.length) return '';
  const joined = themeElements.join(', ');
  return `\nTheme Elements (the image should contain at least some of these): ${joined}`;
}

function prepareSystemMessage(
  config: JudgingConfig,
  promptType: JudgingPromptType,
  responseStructure: string,
  // When provided, replaces config.prompts[promptType] as the task text (rubric-injected review
  // prompt). Undefined leaves output byte-identical to the pre-override behavior.
  promptOverride?: string
) {
  // Remove leading whitespace
  const taskSummary = stripLeadingWhitespace(promptOverride ?? config.prompts[promptType]);
  responseStructure = stripLeadingWhitespace(responseStructure);

  const text = `${config.prompts.systemMessage}\n\n${taskSummary}\n\nReply with json\n\n${responseStructure}`;

  return {
    role: 'system' as const,
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
  };
}

/** Prompt types that can be used with prepareSystemMessage. Excludes deprecated 'article' field. */
type JudgingPromptType = Exclude<keyof ChallengePrompts, 'article'>;
