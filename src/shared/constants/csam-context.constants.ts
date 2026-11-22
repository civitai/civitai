/** Where a moderator takes what a CSAM report can't carry. A policy decision, said the same way everywhere. */
export const CSAM_PRIVATE_ROUTE = 'tell [WHO: pending] privately';

/** A report with no image can't be sent, while filing it still removes the account: never say "file". */
export const CSAM_IMAGE_FILING_NO_IMAGE_REFUSAL = `Nothing was filed. An image report needs at least one image that still exists. Select only the images you are reporting; don't add one just to file. If there is no image to report, or it no longer exists, don't file here: ${CSAM_PRIVATE_ROUTE} now. It may still need to be reported.`;
