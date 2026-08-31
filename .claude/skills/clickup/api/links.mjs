/**
 * ClickUp links and attachments API methods
 */

import { addTaskLink, removeTaskLink } from './tasks.mjs';

// Re-export from tasks.mjs to avoid duplication
export { addTaskLink, removeTaskLink };

// Add an external URL reference via comment
// (ClickUp doesn't have a dedicated external links field, so we use comments)
export async function addExternalLink(taskId, url, description = null) {
  const { postComment } = await import('./comments.mjs');

  const text = description
    ? `**Reference**: [${description}](${url})`
    : `**Reference**: ${url}`;

  return postComment(taskId, text);
}
