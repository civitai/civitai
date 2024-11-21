import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dbRead } from '~/server/db/client';
import { Score } from '~/server/games/daily-challenge/daily-challenge.utils';
import { ReviewReactions } from '~/shared/utils/prisma/enums';
import { markdownToHtml } from '~/utils/markdown-helpers';

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
export async function generateCollectionDetails(input: GenerateCollectionDetailsInput) {
  // TODO - Implement GenCollection
  return {
    name: '',
    description: '',
  };
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
};
export async function generateArticle(input: GenerateArticleInput) {
  // TODO - Implement GenArticle
  const results = {
    title: '',
    invitation: '',
    body: '',
    theme: '',
  };

  // TODO - Append submission and prize details
  const markdownContent = '';
  const content = await markdownToHtml(markdownContent);

  return {
    title: results.title,
    content,
    invitation: results.invitation,
    theme: results.theme,
  };
}

type GenerateReviewInput = {
  theme: string;
  creator: string;
  imageUrl: string;
};
export async function generateReview(input: GenerateReviewInput) {
  // TODO - Implement GenReview
  return {
    score: {
      theme: 10, // 0-10 how well it adheres to the theme
      wittiness: 10, // 0-10 how witty it is
      humor: 10, // 0-10 how funny it is
      aesthetic: 10, // 0-10 how aesthetically pleasing it is
    },
    reaction: 'Heart' as ReviewReactions,
    comment: 'the content of the comment',
    summary: 'concise summary of the content of the image',
  };
}

type GenerateWinnersInput = {
  entries: Array<{
    creator: string;
    summary: string;
    score: Score;
  }>;
  theme: string;
};
export async function generateWinners(input: GenerateWinnersInput) {
  // TODO - Implement GenWinners
  return {
    winners: [
      {
        creator: 'name of the creator',
        reason: 'why you chose them and what you liked about their image',
      },
    ],
    process: 'about your judging process and the challenge as markdown',
    outcome: 'summary about the outcome of the challenge as markdown',
  };
}
