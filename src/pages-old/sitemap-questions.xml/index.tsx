import type { GetServerSideProps } from 'next';
import { QuestionSort } from '~/server/common/enums';
import { getQuestions } from '~/server/services/question.service';
import { respondWithSitemap, type SitemapField } from '~/server/utils/sitemap';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
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

  const fields: SitemapField[] = data.items.map((question) => ({
    loc: `${getBaseUrl()}/questions/${question.id}/${slugit(question.title)}`,
    lastmod: question.updatedAt.toISOString(),
  }));

  return respondWithSitemap(ctx, fields);
};

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function QuestionsSitemap() {}
