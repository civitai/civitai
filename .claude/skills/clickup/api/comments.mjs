/**
 * ClickUp comments API methods
 */

import { apiRequest } from './client.mjs';
import { markdownToClickUp } from '../lib/markdown.mjs';

// Get task comments
export async function getComments(taskId) {
  const response = await apiRequest(`/task/${taskId}/comment`);
  return response.comments || [];
}

// Post a comment (with optional markdown formatting)
export async function postComment(taskId, text, useMarkdown = true) {
  let body;

  if (useMarkdown) {
    const commentArray = markdownToClickUp(text);
    body = JSON.stringify({ comment: commentArray });
  } else {
    body = JSON.stringify({ comment_text: text });
  }

  const response = await apiRequest(`/task/${taskId}/comment`, {
    method: 'POST',
    body,
  });
  return response;
}
