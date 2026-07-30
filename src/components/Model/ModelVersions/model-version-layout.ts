export type ModelVersionActionBranch = 'request-review' | 'publish-pending' | 'default';

export type ModelVersionActionLayout = {
  branch: ModelVersionActionBranch;
  showDownloadSection: boolean;
};

/**
 * The action column renders exactly one of three branches. Download availability is deliberately
 * NOT derived from that branch: it used to live inside the `default` branch's JSX, so an
 * owner-or-moderator reviewing an unpublished model — routed to `publish-pending` — silently lost
 * every download control on the models they most need the file for.
 */
export function getModelVersionActionLayout({
  showRequestReview,
  showPublishButton,
  hideDownload,
  isComponentOnlyModel,
  hasVisibleFiles,
}: {
  showRequestReview: boolean;
  showPublishButton: boolean;
  hideDownload: boolean;
  isComponentOnlyModel: boolean;
  hasVisibleFiles: boolean;
}): ModelVersionActionLayout {
  const branch: ModelVersionActionBranch = showRequestReview
    ? 'request-review'
    : showPublishButton
    ? 'publish-pending'
    : 'default';

  return {
    branch,
    // `request-review` is the one branch that stays a lone button: it is shown only to a non-moderator
    // owner of TOS-violating content, where the actionable next step is the appeal, not the file.
    showDownloadSection:
      branch !== 'request-review' && !hideDownload && !isComponentOnlyModel && hasVisibleFiles,
  };
}
