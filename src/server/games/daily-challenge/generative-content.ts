import dayjs from '~/shared/utils/dayjs';

import type {
  ChallengePrompts,
  JudgingConfig,
  Prize,
  Score,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { openrouter, AI_MODELS } from '~/server/services/ai/openrouter';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { markdownToHtml } from '~/utils/markdown-helpers';
import { asOrdinal, numberWithCommas } from '~/utils/number-helpers';
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
};
type CollectionDetails = {
  name: string;
  description: string;
};
export async function generateCollectionDetails(input: GenerateCollectionDetailsInput) {
  if (!openrouter) throw new Error('OpenRouter not connected');

  const results = await openrouter.getJsonCompletion<CollectionDetails>({
    retries: 3,
    model: AI_MODELS.GROK,
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
  config: JudgingConfig;
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
  challengeDate,
  prizes,
  entryPrizeRequirement,
  entryPrize,
  config,
}: GenerateArticleInput) {
  if (!openrouter) throw new Error('OpenRouter not connected');

  const result = await openrouter.getJsonCompletion<GeneratedArticle>({
    retries: 3,
    model: AI_MODELS.GROK,
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
            text: `Resource title: ${resource.title}\nResource link: https://civitai.com/models/${resource.modelId}\nCreator: ${resource.creator}\nCreator link: https://civitai.com/user/${resource.creator}`,
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

    ## 🤔 How to Create Entries
    Use the **Generate** button on this page to open the on-site generator with the challenge model pre-loaded. Type in your prompt, generate images, and submit your favorites!

    You can also:
    - Browse the [model gallery](/models/${
      resource.modelId
    }) and **Remix** any image to create your own version.
    - Upload images you've created locally using the challenge [model](/models/${resource.modelId}).

    ## 📝 How to Submit
    Click the **Submit** button on this page to open the submission panel. You can submit entries from:
    - **From Generator** — select images you just generated on-site.
    - **My Images** — choose from your existing image library.
    - **Upload New** — drag and drop images created outside of Civitai.

    ## ⭐ Prizes
    **Winners will receive**:
    ${prizes
      .map(
        (prize, i) =>
          `- **${asOrdinal(i + 1)}**: <span style="color:#fab005">${numberWithCommas(
            prize.buzz
          )} Buzz</span>, ${prize.points} Challenge Points`
      )
      .join('\n')}

    Winners will be announced at 12am UTC and notified via on-site notification.

    **Participation rewards!**:
    Submit ${entryPrizeRequirement} valid entries to earn <span style="color:#228be6">${
    entryPrize.buzz
  } Buzz</span> and ${
    entryPrize.points
  } Challenge Points. Only entries that follow the rules below count toward this reward!

    ## 📜 Rules
    1. All entries must be submitted before the end of ${dayjs(challengeDate).format(
      'MMMM DD'
    )} (23:59 UTC).
    2. All submitted images must be SFW (PG) and adhere to our **Terms of Service**.
    3. Participants can submit up to ${entryPrizeRequirement * 2} images.
    4. Low-effort entries are not allowed. Submitting entries with no relevance to the challenge, with the intention of farming Participation Reward Buzz, may result in a Contest Ban. Contest-banned users will be prohibited from participating in all future Civitai contests!
    5. Entries must use the provided model.
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
};
type GeneratedReview = {
  score: Score;
  reaction: ReviewReactions;
  comment: string;
  summary: string;
};
export async function generateReview(input: GenerateReviewInput) {
  if (!openrouter) throw new Error('OpenRouter not connected');

  const result = await openrouter.getJsonCompletion<GeneratedReview>({
    retries: 3,
    model: AI_MODELS.GROK,
    messages: [
      prepareSystemMessage(
        input.config,
        'review',
        `{
          "score": {
          "theme": number, // 0-10 how well it adheres to the theme
          "wittiness": number, // 0-10 how witty it is
          "humor": number, // 0-10 how funny it is
          "aesthetic": number // 0-10 how aesthetically pleasing it is
          },
          "reaction": "a single emoji reaction", // options are "Laugh", "Heart", "Like", "Cry"
          "comment": "the content of the comment",
          "summary": "concise summary of the content of the image"
        }`
      ),
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: `Theme: ${input.theme}\nCreator: ${input.creator}`,
          },
          {
            type: 'image_url' as const,
            image_url: {
              url: input.imageUrl,
            },
          },
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

  const result = await openrouter.getJsonCompletion<GeneratedWinners>({
    retries: 3,
    model: AI_MODELS.GROK,
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
            text: `Theme: ${input.theme}\nEntries:\n\`\`\`json \n${JSON.stringify(
              input.entries,
              null,
              2
            )}\n\`\`\``,
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
