export const FILES_PROCESSING_MESSAGE =
  'Some of your files are still processing. Please try again shortly.';

/** A partial batch's reason: the runs that started can't be retried alone, so it doesn't say "try again". */
export const FILES_PROCESSING_PARTIAL_REASON = 'some of your files were still processing';

/** `code` on the shell's /api/train error body, so the browser can rebuild `FilesProcessingError`. */
export const FILES_PROCESSING_CODE = 'filesProcessing';

/** The orchestrator refused a submit because a dataset file isn't ready yet; resubmitting later works. */
export class FilesProcessingError extends Error {
  constructor() {
    super(FILES_PROCESSING_MESSAGE);
    this.name = 'FilesProcessingError';
  }
}
