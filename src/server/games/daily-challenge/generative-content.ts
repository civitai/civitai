import type {
  ChallengePrompts,
  JudgingConfig,
  Prize,
  Score,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { openrouter, AI_MODELS, type AIModel } from '~/server/services/ai/openrouter';
import type { SimpleMessage } from '~/server/services/ai/openrouter';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { findLastIndex } from '~/utils/array-helpers';
import { markdownToHtml } from '~/utils/markdown-helpers';
import { stripLeadingWhitespace } from '~/utils/string-helpers';
import {
  parseReviewTemplate,
  resolveTemplate,
  type ReviewTemplateVariables,
} from './template-engine';

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
  if (!openrouter) throw new Error('OpenRouter not connected');

  const results = await openrouter.getJsonCompletion<CollectionDetails>({
    retries: 3,
    model: input.model ?? AI_MODELS.GROK,
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
};
export async function generateArticle({ resource, image, config, model }: GenerateArticleInput) {
  if (!openrouter) throw new Error('OpenRouter not connected');

  const userText = `Resource title: ${resource.title}\nResource link: https://civitai.com/models/${resource.modelId}\nCreator: ${resource.creator}\nCreator link: https://civitai.com/user/${resource.creator}`;

  const result = await openrouter.getJsonCompletion<GeneratedArticle>({
    retries: 3,
    model: model ?? AI_MODELS.GROK,
    messages: [
      prepareSystemMessage(
        config,
        'content',
        `{
          "title": "title of the challenge/article",
          "invitation": "a single sentence invitation to participate in the challenge displayed in the on-site generator",
          "body": "the content of the article in markdown",
          "theme": "a 1-2 word theme for the challenge"
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
  };
}

type GenerateReviewInput = {
  theme: string;
  creator: string;
  imageUrl: string;
  config: JudgingConfig;
  model?: AIModel;
};
type GeneratedReview = {
  score: Score;
  reaction: ReviewReactions;
  comment: string;
  summary: string;
  aestheticFlaws?: string[];
};

const RESPONSE_SCHEMA = `{
  "score": {
    "theme": number,     // 0-10
    "wittiness": number, // 0-10
    "humor": number,     // 0-10
    "aesthetic": number  // 0-10
  },
  "reaction": "Laugh" | "Heart" | "Like" | "Cry",
  "comment": "your review comment (2-3 sentences)",
  "summary": "concise factual summary of the image"
  "aestheticFlaws": ["string describing flaw 1","string describing flaw 2",...] // optional array of strings describing specific aesthetic flaws in the image 
}`;

export async function generateReview(input: GenerateReviewInput): Promise<GeneratedReview> {
  if (!openrouter) throw new Error('OpenRouter not connected');

  let messages: SimpleMessage[];
  if (input.config.reviewTemplate) {
    try {
      messages = buildMessagesFromTemplate(input);
    } catch (e) {
      console.warn('[generateReview] Invalid reviewTemplate, falling back to default prompts:', e);
      messages = buildFallbackMessages(input);
    }
  } else {
    messages = buildFallbackMessages(input);
  }

  const result = await openrouter.getJsonCompletion<GeneratedReview>({
    retries: 3,
    model: input.model ?? AI_MODELS.GROK,
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
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: `Theme: ${input.theme}\nCreator: ${input.creator}` },
      { type: 'image_url', image_url: { url: input.imageUrl } },
    ],
  });

  return messages;
}

/**
 * Build simple 2-message array from systemPrompt + reviewPrompt fields (fallback path).
 */
function buildFallbackMessages(input: GenerateReviewInput): SimpleMessage[] {
  const userText = `Theme: ${input.theme}\nCreator: ${input.creator}`;

  return [
    prepareSystemMessage(input.config, 'review', RESPONSE_SCHEMA),
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
  if (!openrouter) throw new Error('OpenRouter not connected');

  const userText = `Theme: ${input.theme}\nEntries:\n\`\`\`json \n${JSON.stringify(
    input.entries,
    null,
    2
  )}\n\`\`\``;

  const result = await openrouter.getJsonCompletion<GeneratedWinners>({
    retries: 3,
    model: input.model ?? AI_MODELS.GROK,
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

function prepareSystemMessage(
  config: JudgingConfig,
  promptType: JudgingPromptType,
  responseStructure: string
) {
  // Remove leading whitespace
  const taskSummary = stripLeadingWhitespace(config.prompts[promptType]);
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
