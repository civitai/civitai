/**
 * Extract a JSON value from a model completion: direct parse first, then the
 * markdown-fenced ```json block some models emit despite json_object mode.
 * CRLF-tolerant. Returns undefined when nothing parses — callers fail closed.
 */
export function extractJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const jsonBlockMatch = content.match(/```json\r?\n(.*?)\r?\n```/s)?.[1];
    if (jsonBlockMatch) {
      try {
        return JSON.parse(jsonBlockMatch);
      } catch {
        // fall through
      }
    }
  }
  return undefined;
}
