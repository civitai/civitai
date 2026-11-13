import { subjectKey } from '$lib/url-subject';

/** What makes a batch a different batch. `offset` is excluded because paging moves the window over the
 *  same batch. (The selection itself is pruned to the page by `ImageActionBar`.) */
export const batchKey = (url: URL) => subjectKey(url, ['offset']);
