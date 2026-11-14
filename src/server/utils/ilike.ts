/**
 * An ILIKE pattern that contains `text` literally: `%`, `_` and the backslash are escaped, so the rows
 * matched are the ones the text describes, e.g. the text a query audit passed.
 */
export const ilikeContains = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;
