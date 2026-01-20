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

// Format doc for display
export function formatDoc(doc) {
  const lines = [];

  lines.push(`Doc: ${doc.name}`);
  lines.push(`ID: ${doc.id}`);
  if (doc.date_created) {
    lines.push(`Created: ${formatDateTime(doc.date_created)}`);
  }
  if (doc.date_updated) {
    lines.push(`Updated: ${formatDateTime(doc.date_updated)}`);
  }
  if (doc.creator) {
    lines.push(`Creator: ${doc.creator.username || doc.creator.email || doc.creator.id}`);
  }
  if (doc.workspace_id) {
    lines.push(`Workspace: ${doc.workspace_id}`);
  }

  return lines.join('\n');
}

// Format doc list for display
export function formatDocList(docs) {
  if (docs.length === 0) {
    return 'No docs found.';
  }

  const lines = [];
  for (const doc of docs) {
    const updated = doc.date_updated ? formatDate(doc.date_updated) : '';
    lines.push(`${doc.name}`);
    lines.push(`  ID: ${doc.id}${updated ? ` | Updated: ${updated}` : ''}`);
    lines.push('');
  }

  lines.push(`Total: ${docs.length} doc(s)`);
  return lines.join('\n');
}

// Format page for display
export function formatPage(page) {
  const lines = [];

  lines.push(`Page: ${page.name}`);
  lines.push(`ID: ${page.id}`);
  if (page.sub_title) {
    lines.push(`Subtitle: ${page.sub_title}`);
  }
  if (page.date_created) {
    lines.push(`Created: ${formatDateTime(page.date_created)}`);
  }
  if (page.date_updated) {
    lines.push(`Updated: ${formatDateTime(page.date_updated)}`);
  }

  if (page.content) {
    lines.push('');
    lines.push('Content:');
    lines.push('---');
    lines.push(page.content);
    lines.push('---');
  }

  return lines.join('\n');
}

// Format page list for display
export function formatPageList(pages, indent = 0) {
  if (pages.length === 0) {
    return 'No pages found.';
  }

  const lines = [];
  const prefix = '  '.repeat(indent);

  for (const page of pages) {
    lines.push(`${prefix}${page.name}`);
    lines.push(`${prefix}  ID: ${page.id}`);

    // Handle nested pages
    if (page.pages?.length > 0) {
      lines.push(formatPageList(page.pages, indent + 1));
    }
    lines.push('');
  }

  if (indent === 0) {
    lines.push(`Total: ${pages.length} page(s)`);
  }
  return lines.join('\n');
}
