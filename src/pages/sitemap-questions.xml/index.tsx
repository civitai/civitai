import { MetricTimeframe } from '@prisma/client';
import { GetServerSideProps } from 'next';
import { ISitemapField, getServerSideSitemapLegacy } from 'next-sitemap';
import { QuestionSort } from '~/server/common/enums';
import { getQuestions } from '~/server/services/question.service';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const data = await getQuestions({
    page: 1,
    limit: 1000,
    period: MetricTimeframe.AllTime,
    sort: QuestionSort.MostLiked,
    select: {
      id: true,
      title: true,
      updatedAt: true,
    },
  }).catch(() => ({ items: [] }));

  const fields: ISitemapField[] = data.items.map((question) => ({
    loc: `${getBaseUrl()}/questions/${question.id}/${slugit(question.title)}`,
    lastmod: question.updatedAt.toISOString(),
  }));

  return getServerSideSitemapLegacy(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function QuestionsSitemap() {}
