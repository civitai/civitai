import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { ArticleRatingReviewModalProps } from '~/components/Article/ArticleRatingReviewModal';

const ArticleRatingReviewModal = dynamic(
  () => import('~/components/Article/ArticleRatingReviewModal'),
  { ssr: false }
);

export const openArticleRatingReviewModal = (props: ArticleRatingReviewModalProps) =>
  dialogStore.trigger({
    id: 'article-rating-review',
    component: ArticleRatingReviewModal,
    props,
  });
