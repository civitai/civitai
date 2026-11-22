import type { ServiceReviewReportAction } from '@civitai/shared/post-text-report';

export type ServiceReviewAction = ServiceReviewReportAction;
export type ServiceReviewText = 'comment' | 'reply';

/** The buyer review a report in the offering queue is about, as it is now. */
export type ReportedServiceReview = {
  reviewId: number;
  dealId: number;
  verdict: string;
  comment: string | null;
  sellerReply: string | null;
  /** The words when reported (the report's snapshot); null on a report without one. */
  reportedComment: string | null;
  reportedReply: string | null;
  shown: boolean;
  hidden: boolean;
  /** Each text held for csam review: decided in the CSAM text-hold queue, never from a report. */
  commentHeld: boolean;
  replyHeld: boolean;
  /** Its images, hidden or not: the Image row's `url` key. */
  images: { id: number; url: string }[];
};
