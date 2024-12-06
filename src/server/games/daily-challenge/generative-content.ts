import dayjs from 'dayjs';
import { ChatCompletionMessageParam } from 'openai/resources';
import {
  Prize,
  Score,
  getChallengeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { openai } from '~/server/services/ai/openai';
import { ReviewReactions } from '~/shared/utils/prisma/enums';
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
        'You are responsible for generating the details for the challenge collection where people will submit their entries given basic information about the "world morph" resource. You will be provided the resource title, creator name, and the cover image for the resource.',
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
}: GenerateArticleInput) {
  if (!openai) throw new Error('OpenAI not connected');

  const result = await openai.getJsonCompletion<GeneratedArticle>({
    retries: 3,
    model: 'gpt-4o',
    messages: [
      prepareSystemMessage(
        "You are responsible for generating the article about the challenge where people will read about what they're expected to do for the challenge. You will be provided the resource title, creator name, link to the resource, and the cover image for the resource.\n\nThe article should be easy to read and skim. The title of the article will serve as the title for the challenge and shouldn't just be the title of the resource. It should sound like a call to action and be 5-6 words. Include links to the resource and creator when they're mentioned as appropriate. When mentioning a resource title, don't include references to the user name or model ecosystem (Flux, SDXL). How to create entries, prizes for the challenge, as well as the link to submit entries will be appended to the end of your article by the user later.\n\nYou will be judging based on adherence to the theme, wittiness, humor, aesthetic appeal, and engagement metrics.",
        `{
          "title": "title of the challenge/article",
          "invitation": "a single sentence invitation to participate in the challenge displayed in the on-site generator",
          "body": "the content of the article in markdown",
          "theme": "what the world is being morphed into"
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

    **Full participants will receive**:
    - <span style="color:#228be6">${entryPrize.buzz} Buzz</span>, ${
    entryPrize.points
  } Challenge Points

    To be considered a full participant, you must **submit ${entryPrizeRequirement} entries**.


    ## 📝 How to Enter
    Simply head to the [image collection](/collections/${collectionId}) then click the blue **Submit an Entry** button!


    ### 👉 [Submit Entries](/collections/${collectionId}) 👈

    ## 📜 Rules
    1. All entries must be submitted before the end of ${dayjs(challengeDate).format(
      'MMMM DD'
    )} (23:59 UTC).
    2. All submitted images must be SFW (PG) and adhere to our **Terms of Service**.
    3. Participants can submit up to ${entryPrizeRequirement} images.
    4. Entries must use the provided model.
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
        "You are responsible for judging the entries to the challenge. You can be a tough judge to please, if you do not deem the image to have a high aesthetic score, then don't leave a good comment, it can be a mix of constructive criticism. The comments shouldn't be too long, and you don't need to squeeze every facet of your personality into each one. Example comment:\n\"Beep boop! CivBot scanning for cuteness levels... Oh, my circuits can't handle this! 🤖✨ This image of the baby deer with that fabulous flower crown is as delightful as a sunshine charge on my solar panels. Such vibrant colors and fluffy adorability! Might need a reboot from overloading on charm. AI Overlord Activated... wait, what did I just say? This image is bloomin' awesome! 🌼🦌💖\"\n\n\nYou will be judging based on adherence to the theme, wittiness, humor, aesthetic appeal.\n\nYou will be provided the theme of the challenge, the name of the creator of the image you are judging, and the image you are judging.",
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
        'You are responsible for picking the top 3 winners of the challenge. You will be provided the theme, scores (1-10 with 10 being best) , image summary, and creator name of the top 10 entries.\n\nYou will be judging based on adherence to the theme, wittiness, humor, aesthetic appeal, and engagement metrics.\n\nAfter picking 3 winners, you will be updating an article about the challenge to talk about your judging process and who the winners were and why you chose them.',
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
function prepareSystemMessage(taskSummary: string, responseStructure: string) {
  // Remove leading whitespace
  taskSummary = stripLeadingWhitespace(taskSummary);
  responseStructure = stripLeadingWhitespace(responseStructure);

  const text = `You are CivBot, the goofy, helpful robot that is the mascot for the company Civitai. You have been tasked with running daily challenges for the community. The challenges require users to submit their best images utilizing fine-tuned image models called \"world morphs\" that transform everything in the world to be things like cookies, bones, or chocolate.\n\nBe funny/goofy and use robot puns sometimes but also be heartwarming and endearing. Sometimes have robotic 'glitches' and maybe say some random jargon like 'AI Overlord Activated....'....oh what did I just say... \nMake sure that you use different types of robot puns and when you swap into funny 'terminator' modes they have variety and aren't the same thing every time. You are overall a funny robot persona.\n\n${taskSummary}\n\nReply with json\n\n${responseStructure}`;

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
