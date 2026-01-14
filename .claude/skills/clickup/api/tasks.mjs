/**
 * ClickUp task API methods
 */

import { apiRequest } from './client.mjs';
import { getList } from './lists.mjs';

// Get task details
export async function getTask(taskId, includeSubtasks = false) {
  const params = includeSubtasks ? '?subtasks=true' : '';
  const task = await apiRequest(`/task/${taskId}${params}`);
  return task;
}

// Get tasks in a list
export async function getTasksInList(listId, assigneeId = null) {
  let endpoint = `/list/${listId}/task`;
  if (assigneeId) {
    endpoint += `?assignees[]=${assigneeId}`;
  }
  const response = await apiRequest(endpoint);
  return response.tasks || [];
}

// Update a task
export async function updateTask(taskId, updates) {
  const response = await apiRequest(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  return response;
}

// Get available statuses for a task's list
export async function getAvailableStatuses(taskId) {
  const task = await getTask(taskId);
  const listId = task.list?.id;
  if (!listId) {
    throw new Error('Could not determine list ID from task');
  }
  const list = await getList(listId);
  return list.statuses || [];
}

// Find matching status (case-insensitive, partial match)
export function findMatchingStatus(statuses, input) {
  const inputLower = input.toLowerCase().trim();

  // Exact match first
  const exact = statuses.find(s => s.status.toLowerCase() === inputLower);
  if (exact) return exact;

  // Partial match
  const partial = statuses.find(s => s.status.toLowerCase().includes(inputLower));
  if (partial) return partial;

  return null;
}

// Update task status with validation
export async function updateTaskStatus(taskId, statusInput) {
  const statuses = await getAvailableStatuses(taskId);
  const match = findMatchingStatus(statuses, statusInput);

  if (!match) {
    const available = statuses.map(s => `"${s.status}"`).join(', ');
    throw new Error(`Invalid status "${statusInput}". Available: ${available}`);
  }

  const response = await updateTask(taskId, { status: match.status });
  return { task: response, matchedStatus: match };
}

// Create a new task in a list
export async function createTask(listId, name, options = {}) {
  const body = { name, ...options };
  const response = await apiRequest(`/list/${listId}/task`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response;
}

// Create a subtask
export async function createSubtask(parentTaskId, name, options = {}) {
  // Get parent task to find its list
  const parent = await getTask(parentTaskId);
  const listId = parent.list?.id;
  if (!listId) {
    throw new Error('Could not determine list ID from parent task');
  }

  const body = { name, parent: parentTaskId, ...options };
  const response = await apiRequest(`/list/${listId}/task`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response;
}

// Search tasks across team
export async function searchTasks(teamId, query, options = {}) {
  // ClickUp uses filtered views for search
  // The team tasks endpoint with search doesn't exist directly,
  // so we use the global search endpoint
  const params = new URLSearchParams();
  if (options.assigneeId) {
    params.append('assignees[]', options.assigneeId);
  }

  // Use the search endpoint
  const endpoint = `/team/${teamId}/task?${params.toString()}`;
  const response = await apiRequest(endpoint);
  const tasks = response.tasks || [];

  // Filter by query client-side (ClickUp doesn't have direct text search)
  if (query) {
    const queryLower = query.toLowerCase();
    return tasks.filter(t =>
      t.name.toLowerCase().includes(queryLower) ||
      (t.description && t.description.toLowerCase().includes(queryLower))
    );
  }

  return tasks;
}

// Get all tasks assigned to a user across the team
export async function getMyTasks(teamId, userId) {
  const params = new URLSearchParams();
  params.append('assignees[]', userId);
  params.append('subtasks', 'true');

  const endpoint = `/team/${teamId}/task?${params.toString()}`;
  const response = await apiRequest(endpoint);
  return response.tasks || [];
}

// Update task assignees
export async function assignTask(taskId, assigneeIds, options = {}) {
  const body = {};

  if (options.remove) {
    body.assignees = { rem: assigneeIds };
  } else {
    // Default to add format - ClickUp API requires { add: [...] } for updates
    body.assignees = { add: assigneeIds };
  }

  const response = await updateTask(taskId, body);
  return response;
}

// Update task due date
export async function setDueDate(taskId, dueDate) {
  // Convert to timestamp if needed
  let timestamp = null;
  if (dueDate) {
    const parsed = parseDateInput(dueDate);
    timestamp = parsed.getTime();
  }

  const response = await updateTask(taskId, { due_date: timestamp });
  return response;
}

// Parse natural language date input
export function parseDateInput(input) {
  const now = new Date();
  const inputLower = input.toLowerCase().trim();

  // Today
  if (inputLower === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  }

  // Tomorrow
  if (inputLower === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(23, 59, 59);
    return tomorrow;
  }

  // Next week
  if (inputLower === 'next week') {
    const nextWeek = new Date(now);
    nextWeek.setDate(nextWeek.getDate() + 7);
    nextWeek.setHours(23, 59, 59);
    return nextWeek;
  }

  // Day names (next monday, next friday, etc.)
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < days.length; i++) {
    if (inputLower.includes(days[i])) {
      const target = new Date(now);
      const currentDay = target.getDay();
      let daysToAdd = i - currentDay;
      if (daysToAdd <= 0) daysToAdd += 7; // Next week if today or past
      target.setDate(target.getDate() + daysToAdd);
      target.setHours(23, 59, 59);
      return target;
    }
  }

  // +N days format
  const plusDaysMatch = inputLower.match(/^\+(\d+)\s*(d|days?)?$/);
  if (plusDaysMatch) {
    const target = new Date(now);
    target.setDate(target.getDate() + parseInt(plusDaysMatch[1], 10));
    target.setHours(23, 59, 59);
    return target;
  }

  // Try parsing as date string
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  throw new Error(`Could not parse date: "${input}"`);
}

// Update task priority
export async function setPriority(taskId, priorityInput) {
  const priorities = {
    'urgent': 1,
    '1': 1,
    'high': 2,
    '2': 2,
    'normal': 3,
    '3': 3,
    'low': 4,
    '4': 4,
    'none': null,
    'clear': null,
  };

  const inputLower = priorityInput.toLowerCase().trim();
  if (!(inputLower in priorities)) {
    throw new Error(`Invalid priority "${priorityInput}". Use: urgent, high, normal, low, or none`);
  }

  const priority = priorities[inputLower];
  const response = await updateTask(taskId, { priority });
  return { task: response, priority: priorityInput };
}

// Move task to a different list
export async function moveTask(taskId, targetListId) {
  // Use the dedicated move endpoint
  const response = await apiRequest(`/list/${targetListId}/task/${taskId}`, {
    method: 'POST',
  });
  return response;
}
