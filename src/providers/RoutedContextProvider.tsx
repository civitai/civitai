import dynamic from 'next/dynamic';

import Router, { useRouter } from 'next/router';

const ModelVersionLightbox = dynamic(() => import('~/routed-context/modals/ModelVersionLightbox'));
const ReviewLightbox = dynamic(() => import('~/routed-context/modals/ReviewLightbox'));
const ReviewEdit = dynamic(() => import('~/routed-context/modals/ReviewEdit'));
const RunStrategy = dynamic(() => import('~/routed-context/modals/RunStrategy'));
const ReviewThread = dynamic(() => import('~/routed-context/modals/ReviewThread'));
const CommentThread = dynamic(() => import('~/routed-context/modals/CommentThread'));
const CommentEdit = dynamic(() => import('~/routed-context/modals/CommentEdit'));
const Report = dynamic(() => import('~/routed-context/modals/Report'));
const BlockModelTags = dynamic(() => import('~/routed-context/modals/BlockModelTags'));

const dictionary = {
  modelVersionLightbox: ModelVersionLightbox,
  reviewLightbox: ReviewLightbox,
  reviewEdit: ReviewEdit,
  runStrategy: RunStrategy,
  reviewThread: ReviewThread,
  commentThread: CommentThread,
  commentEdit: CommentEdit,
  report: Report,
  blockTags: BlockModelTags,
};

export function RoutedContextProvider() {}
