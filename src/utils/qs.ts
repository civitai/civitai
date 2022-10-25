import { ParseOptions, StringifyOptions, stringify, parse } from 'query-string';

export abstract class QS {
  static stringify(query: Record<string, unknown>, options?: StringifyOptions) {
    return stringify(query, {
      skipEmptyString: true,
      skipNull: true,
      sort: false,
      ...options,
    });
  }
  static parse<T extends Record<string, unknown>>(search: string, options?: ParseOptions) {
    return parse(search, {
      parseBooleans: true,
      parseNumbers: true,
      sort: false,
      ...options,
    }) as T;
  }
}
