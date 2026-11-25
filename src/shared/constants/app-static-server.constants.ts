/**
 * The file extensions the App Block static server serves with a JavaScript content type, lower
 * case, without the dot.
 *
 * 🔴 MUST MATCH the app static server's MIME table for JavaScript types. A browser refuses to run
 * an ES module whose response is not a JavaScript type, so a module the server sends as
 * `application/octet-stream` never runs and the app never finishes loading. The submit-time
 * module-graph lint (`bundle-module-graph.ts`) refuses a bundle that imports any other extension,
 * and it is only correct while this list is the server's list.
 *
 * This is a HAND COPY of the static server's JavaScript types, not a shared source: the server
 * lives in a separate repository, so it cannot be imported. Drift is guarded only by paired
 * literal pins, one in this repository's test (`bundle-module-graph.test.ts`) and a matching one
 * in the static server's test suite; change both lists, and both pins, together.
 */
export const APP_STATIC_SERVER_JS_EXTENSIONS = ['js', 'mjs'] as const;
