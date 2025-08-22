import dayjs from '~/shared/utils/dayjs';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  ChallengePrompts,
  Prize,
  Score,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { openai } from '~/server/services/ai/openai';
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
  config: ChallengeConfig;
};
type CollectionDetails = {
  name: string;
  description: string;
};
export async function generateCollectionDetails(input: GenerateCollectionDetailsInput) {
  if (!openai) throw new Error('OpenAI not connected');

  const results = await openai.getJsonCompletion<CollectionDetails>({
    retries: 3,
    model: 'gpt-4o',
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
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Resource title: ${input.resource.title}\nCreator: ${input.resource.creator}`,
          },
          {
            type: 'image_url',
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
  collectionId: number;
  challengeDate: Date;
  prizes: Array<Prize>;
  entryPrizeRequirement: number;
  entryPrize: Prize;
  config: ChallengeConfig;
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
  collectionId,
  challengeDate,
  prizes,
  entryPrizeRequirement,
  entryPrize,
  config,
}: GenerateArticleInput) {
  if (!openai) throw new Error('OpenAI not connected');

  const result = await openai.getJsonCompletion<GeneratedArticle>({
    retries: 3,
    model: 'gpt-4o',
    messages: [
      prepareSystemMessage(
        config,
        'article',
        `{
          "title": "title of the challenge/article",
          "invitation": "a single sentence invitation to participate in the challenge displayed in the on-site generator",
          "body": "the content of the article in markdown",
          "theme": "a 1-2 word theme for the challenge"
        }`
      ),
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Resource title: ${resource.title}\nResource link: https://civitai.com/models/${resource.modelId}\nCreator: ${resource.creator}\nCreator link: https://civitai.com/user/${resource.creator}`,
          },
          {
            type: 'image_url',
            image_url: {
              url: image.url,
            },
          },
        ],
      },
    ],
  });

  // TODO - Append submission and prize details
  const markdownContent = stripLeadingWhitespace(`
    ${result.body}

    ## 🤔 How to create entries
    New to these challenges? Here are a few ways to get started:
    - Visit the [resource page](/models/${
      resource.modelId
    }) and click the "Create" button and type in your own prompt to generate images.
    - Browse the [gallery](/models/${
      resource.modelId
    }) and click the "Remix" button on the top right of any image to create your own version.
    - Download the resource from the [resource page](/models/${
      resource.modelId
    }) and use it on your local machine.

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

    Winners will be announced at 12am UTC in this article and notified via on-site notification.

    **Participation rewards!**:
    If you submit ${entryPrizeRequirement} entries, you'll be rewarded <span style="color:#228be6">${
    entryPrize.buzz
  } Buzz</span> and ${
    entryPrize.points
  } Challenge Points. Make sure your entries follow the rules though, because only valid entries will be rewarded!


    ## 📝 How to Enter
    Simply head to the [image collection](/collections/${collectionId}) then click the blue **Submit an Entry** button!


    ### 👉 [Submit Entries](/collections/${collectionId}) 👈

    ## 📜 Rules
    1. All entries must be submitted before the end of ${dayjs(challengeDate).format(
      'MMMM DD'
    )} (23:59 UTC).
    2. All submitted images must be SFW (PG) and adhere to our **Terms of Service**.
    3. Participants can submit up to ${entryPrizeRequirement * 2} images.
    4. Low-effort entries are not allowed. Submitting entries with no relevance to the current contest, with the intention of farming Participation Reward Buzz, may result in a Contest Ban. Contest-banned users will be prohibited from participating in all future Civitai contests!
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
  config: ChallengeConfig;
};
type GeneratedReview = {
  score: Score;
  reaction: ReviewReactions;
  comment: string;
  summary: string;
};
export async function generateReview(input: GenerateReviewInput) {
  if (!openai) throw new Error('OpenAI not connected');

  const result = await openai.getJsonCompletion<GeneratedReview>({
    retries: 3,
    model: 'gpt-4o',
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
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Theme: ${input.theme}\nCreator: ${input.creator}`,
          },
          {
            type: 'image_url',
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
    creator: string;
    summary: string;
    score: Score;
  }>;
  theme: string;
  config: ChallengeConfig;
};
type GeneratedWinners = {
  winners: Array<{
    creator: string;
    reason: string;
  }>;
  process: string;
  outcome: string;
};
export async function generateWinners(input: GenerateWinnersInput) {
  if (!openai) throw new Error('OpenAI not connected');

  const result = await openai.getJsonCompletion<GeneratedWinners>({
    retries: 3,
    model: 'gpt-4o',
    messages: [
      prepareSystemMessage(
        input.config,
        'winner',
        `{
          "winners": [{
          "creator": "name of the creator",
          "reason": "why you chose them and what you liked about their image"
          }],
          "process": "about your judging process and the challenge as markdown",
          "outcome": "summary about the outcome of the challenge as markdown"
        }`
      ),
      {
        role: 'user',
        content: [
          {
            type: 'text',
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
  config: ChallengeConfig,
  promptType: ChallengePromptType,
  responseStructure: string
) {
  // Remove leading whitespace
  const taskSummary = stripLeadingWhitespace(config.prompts[promptType]);
  responseStructure = stripLeadingWhitespace(responseStructure);

  const text = `${config.prompts.systemMessage}\n\n${taskSummary}\n\nReply with json\n\n${responseStructure}`;

  return {
    role: 'system',
    content: [
      {
        type: 'text',
        text,
      },
    ],
  } as ChatCompletionMessageParam;
}

type ChallengeConfig = {
  prompts: ChallengePrompts;
};
type ChallengePromptType = keyof ChallengePrompts;
