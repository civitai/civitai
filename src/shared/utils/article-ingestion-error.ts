/**
 * Why an article's safety scan could not finish, in the words its owner is shown. A missing image
 * never hides an article by itself, so it is only noted beside a failure.
 */
export function articleIngestionErrorReason({
  errorImages,
  missingImages,
  textError,
}: {
  errorImages: number;
  missingImages: number;
  textError: boolean;
}): string | null {
  const parts: string[] = [];
  if (errorImages) parts.push(`${errorImages} image(s) could not be scanned`);
  if (textError) parts.push('the text check could not finish');
  if (!parts.length) return null;
  const failed = parts.join(' and ');
  return missingImages
    ? `${failed}. ${missingImages} image(s) could not be found and are left out of the article`
    : failed;
}

/**
 * The owner's sidebar notice for an article at ingestion Error. `reason` is undefined while the scan
 * status is unknown, and null when nothing failed outright: an image held for a moderator, which the
 * owner is not told about.
 */
export function ingestionErrorNotice({
  reason,
  retrying,
}: {
  reason: string | null | undefined;
  retrying: boolean;
}): string {
  if (reason === null)
    return 'This article is hidden from the public until its safety review is complete.';
  const retry = retrying
    ? 'We retry automatically over the next few days; you can also rescan the affected images, or replace them.'
    : 'You can rescan the affected images, or replace them.';
  return `This article is hidden from the public because its safety scan could not finish${
    reason ? `: ${reason}` : ''
  }. ${retry}`;
}
