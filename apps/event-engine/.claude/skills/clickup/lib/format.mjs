/**
 * Display formatting utilities
 */

import { clickUpToMarkdown } from './markdown.mjs';

// Format date
export function formatDate(timestamp) {
  if (!timestamp) return 'Not set';
  const date = new Date(parseInt(timestamp, 10));
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Format datetime
export function formatDateTime(timestamp) {
  if (!timestamp) return 'Unknown';
  const date = new Date(parseInt(timestamp, 10));
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Format priority
export function formatPriority(priority) {
  if (!priority) return 'None';
  const priorities = {
    1: 'Urgent',
    2: 'High',
    3: 'Normal',
    4: 'Low',
  };
  return priorities[priority.priority] || priority.priority || 'None';
}

// Format task for display
export function formatTask(task) {
  const lines = [];

  lines.push(`Task: ${task.name}`);
  lines.push(`Status: ${task.status?.status || 'Unknown'}`);
  lines.push(`Priority: ${formatPriority(task.priority)}`);

  if (task.assignees?.length > 0) {
    const names = task.assignees.map(a => a.username || a.email).join(', ');
    lines.push(`Assignees: ${names}`);
  }

  lines.push(`Due: ${formatDate(task.due_date)}`);
  lines.push(`Created: ${formatDate(task.date_created)}`);
  lines.push(`URL: ${task.url}`);

  if (task.description) {
    lines.push('');
    lines.push('Description:');
    lines.push(task.description);
  }

  if (task.subtasks?.length > 0) {
    lines.push('');
    lines.push(`Subtasks (${task.subtasks.length}):`);
    for (const sub of task.subtasks) {
      const status = sub.status?.status || 'unknown';
      lines.push(`  - [${status}] ${sub.name}`);
    }
  }

  if (task.tags?.length > 0) {
    lines.push('');
    lines.push(`Tags: ${task.tags.map(t => t.name).join(', ')}`);
  }

  return lines.join('\n');
}

// Format task list for display
export function formatTaskList(tasks) {
  if (tasks.length === 0) {
    return 'No tasks found.';
  }

  const lines = [];
  for (const task of tasks) {
    const status = task.status?.status || '?';
    const priority = formatPriority(task.priority);
    const assignees = task.assignees?.map(a => a.username || a.initials).join(', ') || 'Unassigned';
    const due = task.due_date ? formatDate(task.due_date) : '';

    lines.push(`[${status}] ${task.name}`);
    lines.push(`  ID: ${task.id} | Priority: ${priority} | Assignees: ${assignees}${due ? ` | Due: ${due}` : ''}`);
    lines.push(`  ${task.url}`);
    lines.push('');
  }

  lines.push(`Total: ${tasks.length} task(s)`);
  return lines.join('\n');
}

// Format comments for display
export function formatComments(comments) {
  if (comments.length === 0) {
    return 'No comments on this task.';
  }

  const lines = [];
  for (const comment of comments) {
    const date = formatDateTime(comment.date);
    const user = comment.user?.username || comment.user?.email || 'Unknown';
    // Prefer the comment array (rich formatting) over comment_text (plain text)
    const text = comment.comment ? extractCommentText(comment.comment) : comment.comment_text || '';

    lines.push(`[${date}] ${user}:`);
    lines.push(`  ${text.split('\n').join('\n  ')}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// Extract text from comment array structure and convert to markdown
export function extractCommentText(commentArray) {
  if (!commentArray) return '';
  if (typeof commentArray === 'string') return commentArray;
  if (Array.isArray(commentArray)) {
    return clickUpToMarkdown(commentArray);
  }
  return '';
}
