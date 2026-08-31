/**
 * ClickUp comments API methods
 */

import { apiRequest } from './client.mjs';
import { textToCommentArray } from '../lib/mentions.mjs';

// Get task comments (paginates through all; API returns max 25 per request)
export async function getComments(taskId) {
  const PAGE_SIZE = 25;
  let allComments = [];
  let start = undefined;
  let startId = undefined;

  while (true) {
    const params = new URLSearchParams();
    if (start !== undefined) {
      params.append('start', start);
      params.append('start_id', startId);
    }
    const paramStr = params.toString();
    const endpoint = `/task/${taskId}/comment${paramStr ? '?' + paramStr : ''}`;
    const response = await apiRequest(endpoint);
    const comments = response.comments || [];
    allComments = allComments.concat(comments);

    // If fewer than PAGE_SIZE returned, we've reached the end
    if (comments.length < PAGE_SIZE) break;

    // Use the last comment's date and id as cursor for next page
    const lastComment = comments[comments.length - 1];
    start = lastComment.date;
    startId = lastComment.id;
  }

  return allComments;
}

// Post a comment (with optional markdown formatting)
// options: { useMarkdown: bool, notify_all: bool, assignee: number }
// Backwards compatible: third arg can be a boolean (treated as useMarkdown)
export async function postComment(taskId, text, options = {}) {
  // Backwards compatibility: if options is a boolean, treat as useMarkdown
  if (typeof options === 'boolean') {
    options = { useMarkdown: options };
  }

  const { useMarkdown = true, notify_all, assignee } = options;

  let bodyObj;
  if (useMarkdown) {
    const commentArray = await textToCommentArray(text);
    bodyObj = { comment: commentArray };
  } else {
    bodyObj = { comment_text: text };
  }

  if (notify_all !== undefined) bodyObj.notify_all = notify_all;
  if (assignee !== undefined) bodyObj.assignee = assignee;

  const response = await apiRequest(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify(bodyObj),
  });
  return response;
}

// Update a comment (edit text, resolve, reassign)
export async function updateComment(commentId, updates = {}) {
  const body = {};
  if (updates.comment_text !== undefined) body.comment_text = updates.comment_text;
  if (updates.assignee !== undefined) body.assignee = updates.assignee;
  if (updates.resolved !== undefined) body.resolved = updates.resolved;

  const response = await apiRequest(`/comment/${commentId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return response;
}

// Delete a comment
export async function deleteComment(commentId) {
  const response = await apiRequest(`/comment/${commentId}`, {
    method: 'DELETE',
  });
  return response;
}

// Get threaded replies for a comment
export async function getThreadedComments(commentId) {
  const response = await apiRequest(`/comment/${commentId}/reply`);
  return response.comments || [];
}

// Post a threaded reply to a comment
export async function replyToComment(commentId, text, options = {}) {
  if (typeof options === 'boolean') {
    options = { useMarkdown: options };
  }

  const { useMarkdown = true, notify_all, assignee } = options;

  let bodyObj;
  if (useMarkdown) {
    const commentArray = await textToCommentArray(text);
    bodyObj = { comment: commentArray };
  } else {
    bodyObj = { comment_text: text };
  }

  if (notify_all !== undefined) bodyObj.notify_all = notify_all;
  if (assignee !== undefined) bodyObj.assignee = assignee;

  const response = await apiRequest(`/comment/${commentId}/reply`, {
    method: 'POST',
    body: JSON.stringify(bodyObj),
  });
  return response;
}
