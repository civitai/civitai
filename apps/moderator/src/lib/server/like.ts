// A leaf on purpose: no imports, so a service can use it without pulling another module into the
// import graph of every test that hand-mocks its neighbours.

/** LIKE's own wildcards and escape character, escaped for Postgres's default `\` escape. A pasted term
 *  holding `_` would otherwise match any character in that position, silently widening the result. */
export const escapeLike = (term: string) => term.replace(/([\\%_])/g, '\\$1');
