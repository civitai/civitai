/** A failure with the HTTP status the API answers with. Anything else is a 500. */
export class SearchError extends Error {
  constructor(readonly status: 404 | 412 | 502, message: string) {
    super(message);
    this.name = 'SearchError';
  }
}
