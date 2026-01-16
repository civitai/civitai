/**
 * URL and ID parsing utilities
 */

// Extract task ID from URL or return as-is
export function parseTaskId(input) {
  if (!input) return null;

  // Already a task ID (alphanumeric, typically 9 chars)
  if (/^[a-zA-Z0-9]+$/.test(input) && !input.includes('/')) {
    return input;
  }

  // URL format: https://app.clickup.com/t/{task_id}
  const shortMatch = input.match(/clickup\.com\/t\/([a-zA-Z0-9]+)/);
  if (shortMatch) return shortMatch[1];

  // URL format: https://app.clickup.com/{team_id}/v/li/{list_id}?p={task_id}
  const longMatch = input.match(/[?&]p=([a-zA-Z0-9]+)/);
  if (longMatch) return longMatch[1];

  // URL format with task in path
  const pathMatch = input.match(/\/([a-zA-Z0-9]{7,})(?:\?|$)/);
  if (pathMatch) return pathMatch[1];

  return input; // Return as-is, let API handle validation
}

// Extract list ID from URL or return as-is
export function parseListId(input) {
  if (!input) return null;

  // Already a list ID (numeric)
  if (/^\d+$/.test(input)) {
    return input;
  }

  // URL format: https://app.clickup.com/{team_id}/v/li/{list_id}
  const listMatch = input.match(/\/li\/(\d+)/);
  if (listMatch) return listMatch[1];

  return null; // Not a valid list ID or URL
}

// Extract doc ID from URL or return as-is
// Doc URLs: https://app.clickup.com/{team_id}/v/dc/{doc_id}
// Or: https://app.clickup.com/{team_id}/docs/{doc_id}
export function parseDocId(input) {
  if (!input) return null;

  // Already a doc ID (alphanumeric, typically starts with numbers)
  if (/^[a-zA-Z0-9_-]+$/.test(input) && !input.includes('/')) {
    return input;
  }

  // URL format: https://app.clickup.com/{team_id}/v/dc/{doc_id}
  const dcMatch = input.match(/\/dc\/([a-zA-Z0-9_-]+)/);
  if (dcMatch) return dcMatch[1];

  // URL format: https://app.clickup.com/{team_id}/docs/{doc_id}
  const docsMatch = input.match(/\/docs\/([a-zA-Z0-9_-]+)/);
  if (docsMatch) return docsMatch[1];

  return input; // Return as-is, let API handle validation
}

// Extract page ID from URL or return as-is
export function parsePageId(input) {
  if (!input) return null;

  // Already a page ID (alphanumeric)
  if (/^[a-zA-Z0-9_-]+$/.test(input) && !input.includes('/')) {
    return input;
  }

  // URL format with page parameter: ...?page={page_id} or ...&page={page_id}
  const pageMatch = input.match(/[?&]page=([a-zA-Z0-9_-]+)/);
  if (pageMatch) return pageMatch[1];

  return input; // Return as-is, let API handle validation
}
