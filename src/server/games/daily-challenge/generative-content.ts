import type {
  ChallengePrompts,
  JudgingConfig,
  Prize,
  Score,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { openrouter, AI_MODELS, type AIModel } from '~/server/services/ai/openrouter';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { markdownToHtml } from '~/utils/markdown-helpers';
import { stripLeadingWhitespace } from '~/utils/string-helpers';

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
  userMessageOverride?: string;
};
type GeneratedArticle = {
  title: string;
  body: string;
  invitation: string;
  theme: string;
};
export async function generateArticle({
  resource,
  image,
  config,
  model,
  userMessageOverride,
}: GenerateArticleInput) {
  if (!openrouter) throw new Error('OpenRouter not connected');

  const userText =
    userMessageOverride ??
    `Resource title: ${resource.title}\nResource link: https://civitai.com/models/${resource.modelId}\nCreator: ${resource.creator}\nCreator link: https://civitai.com/user/${resource.creator}`;

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
  userMessageOverride?: string;
  /** Use two-pass review: first a persona-free critical analysis, then persona-scored review */
  multiTurn?: boolean;
};
type GeneratedReview = {
  score: Score;
  reaction: ReviewReactions;
  comment: string;
  summary: string;
};

// Internal: what the LLM returns in single-pass mode (analysis is discarded)
type RawReviewWithAnalysis = {
  critical_analysis: {
    strengths: string;
    weaknesses: string;
    theme_connection: string;
  };
  score: Score;
  reaction: ReviewReactions;
  comment: string;
  summary: string;
};

// Internal: persona-free analysis from first pass of multi-turn
type CriticalAnalysis = {
  strengths: string;
  weaknesses: string;
  theme_connection: string;
  overall_quality: string;
};

const REVIEW_TEMPERATURE = 0.4;

const SCORING_RUBRIC = `SCORING CALIBRATION: Be a critical, honest judge. Most entries should score 4-6 (average). 7-8 means genuinely strong work. 9-10 is rare and reserved for truly exceptional entries. Do NOT default to high scores — grade on a real curve where 5 is the midpoint.`;

const SCORE_SCHEMA = `"score": {
    "theme": number, // 0-10 how well it embodies the challenge theme. 2=off-theme, 5=adequate/obvious take, 7=creative interpretation, 9+=masterful/unexpected brilliance
    "wittiness": number, // 0-10 cleverness of concept/execution. 2=purely literal, 5=mildly clever, 7=genuinely ingenious, 9+=multi-layered brilliance
    "humor": number, // 0-10 comedic value (0 is acceptable for serious entries). 2=no humor, 5=gets a smile, 7=genuinely funny, 9+=hilarious
    "aesthetic": number // 0-10 visual quality/composition/coherence. 2=poor quality/artifacts, 5=acceptable but unremarkable, 7=visually appealing/well-composed, 9+=stunning/exceptional artistry
  }`;

export async function generateReview(input: GenerateReviewInput): Promise<GeneratedReview> {
  if (!openrouter) throw new Error('OpenRouter not connected');

  if (input.multiTurn) {
    return generateReviewMultiTurn(input);
  }
  return generateReviewSinglePass(input);
}

/**
 * Single-pass review: forces the model to write a critical analysis BEFORE scoring.
 * The analysis fields appear first in the JSON schema, so the model commits to identifying
 * strengths/weaknesses before it reaches the score fields — anchoring scores to its critique.
 * Analysis is discarded from the returned result.
 */
async function generateReviewSinglePass(input: GenerateReviewInput): Promise<GeneratedReview> {
  const userText = input.userMessageOverride ?? `Theme: ${input.theme}\nCreator: ${input.creator}`;

  const result = await openrouter!.getJsonCompletion<RawReviewWithAnalysis>({
    retries: 3,
    model: input.model ?? AI_MODELS.GROK,
    temperature: REVIEW_TEMPERATURE,
    messages: [
      prepareSystemMessage(
        input.config,
        'review',
        `${SCORING_RUBRIC}

{
  "critical_analysis": {
    "strengths": "specific things that work well in this image (be concise)",
    "weaknesses": "specific flaws, shortcomings, or missed opportunities (every image has them — identify them honestly)",
    "theme_connection": "how directly and creatively does this connect to the theme — note any weak links or stretches"
  },
  ${SCORE_SCHEMA},
  "reaction": "a single emoji reaction", // options are "Laugh", "Heart", "Like", "Cry"
  "comment": "your review comment in character (2-3 sentences max)",
  "summary": "concise factual summary of the image content"
}`
      ),
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: userText },
          { type: 'image_url' as const, image_url: { url: input.imageUrl } },
        ],
      },
    ],
  });

  // Strip analysis fields — they exist only to anchor the model's scoring
  return {
    score: result.score,
    reaction: result.reaction,
    comment: result.comment,
    summary: result.summary,
  };
}

/**
 * Two-pass review for higher-quality judging (e.g. finals).
 * Pass 1: Persona-free critical analysis — objective, no character bias.
 * Pass 2: Judge persona scores the image, anchored by the prior analysis.
 * Costs 2x API calls but produces the most calibrated scores.
 */
async function generateReviewMultiTurn(input: GenerateReviewInput): Promise<GeneratedReview> {
  // Pass 1: Objective critical analysis (no judge persona)
  const analysis = await openrouter!.getJsonCompletion<CriticalAnalysis>({
    retries: 2,
    model: input.model ?? AI_MODELS.GROK,
    temperature: 0.3,
    messages: [
      {
        role: 'system' as const,
        content: [
          {
            type: 'text' as const,
            text: stripLeadingWhitespace(`You are an objective art critic analyzing an image submission for a creative challenge.
              Be analytical and precise — identify both genuine strengths and real weaknesses.
              Do not be encouraging or generous. Every image has flaws; name them.

              Reply with json

              {
                "strengths": "specific visual and conceptual strengths (be concise)",
                "weaknesses": "specific flaws, technical issues, or conceptual shortcomings (be honest and thorough)",
                "theme_connection": "how well does this connect to the given theme — note any stretches or weak links",
                "overall_quality": "one of: poor, below_average, average, above_average, excellent, exceptional"
              }`),
          },
        ],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: `Theme: ${input.theme}` },
          { type: 'image_url' as const, image_url: { url: input.imageUrl } },
        ],
      },
    ],
  });

  // Pass 2: Judge persona scores, anchored by the objective analysis
  const userText =
    input.userMessageOverride ??
    stripLeadingWhitespace(`Theme: ${input.theme}
      Creator: ${input.creator}

      Prior critical analysis of this image:
      - Strengths: ${analysis.strengths}
      - Weaknesses: ${analysis.weaknesses}
      - Theme connection: ${analysis.theme_connection}
      - Overall quality: ${analysis.overall_quality}

      Use this analysis to inform your scoring. Your scores must be consistent with the identified weaknesses — do not ignore them.`);

  const result = await openrouter!.getJsonCompletion<GeneratedReview>({
    retries: 3,
    model: input.model ?? AI_MODELS.GROK,
    temperature: REVIEW_TEMPERATURE,
    messages: [
      prepareSystemMessage(
        input.config,
        'review',
        `${SCORING_RUBRIC}

{
  ${SCORE_SCHEMA},
  "reaction": "a single emoji reaction", // options are "Laugh", "Heart", "Like", "Cry"
  "comment": "your review comment in character (2-3 sentences max)",
  "summary": "concise factual summary of the image content"
}`
      ),
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: userText },
          { type: 'image_url' as const, image_url: { url: input.imageUrl } },
        ],
      },
    ],
  });

  return result;
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
  userMessageOverride?: string;
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

  const userText =
    input.userMessageOverride ??
    `Theme: ${input.theme}\nEntries:\n\`\`\`json \n${JSON.stringify(
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
