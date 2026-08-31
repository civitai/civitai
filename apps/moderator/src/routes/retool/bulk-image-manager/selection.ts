import { subjectKey } from '$lib/url-subject';

/** What makes a batch a different batch. `offset` is excluded because paging moves the window over the
 *  same images, and the actions post ids rather than what is on screen. */
export const batchKey = (url: URL) => subjectKey(url, ['offset']);
