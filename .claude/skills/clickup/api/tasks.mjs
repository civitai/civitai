/**
 * ClickUp task API methods
 */

import { apiRequest, apiRequestV3, fetchAllPages } from './client.mjs';
import { getList } from './lists.mjs';

// Get task details
export async function getTask(taskId, includeSubtasks = false) {
  const params = includeSubtasks ? '?include_subtasks=true' : '';
  const task = await apiRequest(`/task/${taskId}${params}`);
  return task;
}

// Get tasks in a list
export async function getTasksInList(listId, assigneeId = null) {
  let endpoint = `/list/${listId}/task`;
  if (assigneeId) {
    endpoint += `?assignees[]=${assigneeId}`;
  }
  return fetchAllPages(endpoint, 'tasks');
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

/**
 * Search tasks using the ClickUp v2 filtered-team-tasks endpoint.
 *
 * ClickUp v2 has no native text search, so a text `query` is applied in-process
 * AFTER the server has already scoped the result set with native filters. To
 * keep request volume bounded, at least one scoping filter is required:
 * `assigneeId`, `list_ids`, `project_ids` (folders), `space_ids`, or `statuses`.
 * Pass `options.all = true` to run unscoped across the whole workspace
 * (expect multi-second latency on large teams).
 */
export async function searchTasks(teamId, query, options = {}) {
  const hasScope = !!(
    options.assigneeId ||
    (Array.isArray(options.list_ids) && options.list_ids.length) ||
    (Array.isArray(options.project_ids) && options.project_ids.length) ||
    (Array.isArray(options.space_ids) && options.space_ids.length) ||
    (Array.isArray(options.statuses) && options.statuses.length)
  );
  if (!hasScope && !options.all) {
    const err = new Error(
      'searchTasks requires a scope (assigneeId / list_ids / project_ids / space_ids / statuses) ' +
      'or options.all=true for a full-workspace scan.'
    );
    err.code = 'SCOPE_REQUIRED';
    throw err;
  }

  const params = new URLSearchParams();

  if (options.assigneeId) params.append('assignees[]', options.assigneeId);

  if (Array.isArray(options.statuses)) {
    for (const status of options.statuses) params.append('statuses[]', status);
  }

  if (options.include_closed) params.append('include_closed', 'true');
  if (options.subtasks) params.append('subtasks', 'true');

  if (Array.isArray(options.space_ids)) {
    for (const id of options.space_ids) params.append('space_ids[]', id);
  }
  if (Array.isArray(options.project_ids)) {
    for (const id of options.project_ids) params.append('project_ids[]', id);
  }
  if (Array.isArray(options.list_ids)) {
    for (const id of options.list_ids) params.append('list_ids[]', id);
  }

  const dateFilters = [
    'date_created_gt', 'date_created_lt',
    'date_updated_gt', 'date_updated_lt',
    'due_date_gt', 'due_date_lt',
  ];
  for (const filter of dateFilters) {
    if (options[filter]) params.append(filter, options[filter]);
  }

  const paramStr = params.toString();
  const endpoint = `/team/${teamId}/task${paramStr ? '?' + paramStr : ''}`;
  const tasks = await fetchAllPages(endpoint, 'tasks');

  if (query) {
    const q = query.toLowerCase();
    return tasks.filter(t =>
      t.name.toLowerCase().includes(q) ||
      (t.description && t.description.toLowerCase().includes(q))
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
  return fetchAllPages(endpoint, 'tasks');
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

  const response = await updateTask(taskId, { due_date: timestamp, due_date_time: true });
  return response;
}

// Update task start date
export async function setStartDate(taskId, startDate) {
  // Convert to timestamp if needed
  let timestamp = null;
  if (startDate) {
    const parsed = parseDateInput(startDate);
    timestamp = parsed.getTime();
  }

  const response = await updateTask(taskId, { start_date: timestamp, start_date_time: true });
  return response;
}

// Update task dates (start and/or due)
export async function setDates(taskId, options = {}) {
  const updates = {};
  if (options.start) {
    const parsed = parseDateInput(options.start);
    updates.start_date = parsed.getTime();
    updates.start_date_time = true;
  }
  if (options.due) {
    const parsed = parseDateInput(options.due);
    updates.due_date = parsed.getTime();
    updates.due_date_time = true;
  }
  const response = await updateTask(taskId, updates);
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

// Move task to a different list (v3 endpoint)
export async function moveTask(taskId, targetListId, workspaceId) {
  const response = await apiRequestV3(
    `/workspaces/${workspaceId}/tasks/${taskId}/home_list/${targetListId}`,
    { method: 'PUT' }
  );
  return response;
}

// Archive a task (removes from active views, retrievable later)
export async function archiveTask(taskId) {
  const response = await updateTask(taskId, { archived: true });
  return response;
}

// Unarchive a task (restore from archive)
export async function unarchiveTask(taskId) {
  const response = await updateTask(taskId, { archived: false });
  return response;
}

// Add a watcher/follower to a task via UpdateTask
// Note: ClickUp UI calls these "followers" but the API field is "watchers"
export async function addWatcher(taskId, userId) {
  return updateTask(taskId, { watchers: { add: [parseInt(userId, 10)] } });
}

// Remove a watcher/follower from a task
export async function removeWatcher(taskId, userId) {
  return updateTask(taskId, { watchers: { rem: [parseInt(userId, 10)] } });
}

// Add a tag to a task
export async function addTag(taskId, tagName) {
  // Tag names in URL must be URL-encoded
  const encodedTag = encodeURIComponent(tagName);
  const response = await apiRequest(`/task/${taskId}/tag/${encodedTag}`, {
    method: 'POST',
  });
  return response;
}

// Remove a tag from a task
export async function removeTag(taskId, tagName) {
  const encodedTag = encodeURIComponent(tagName);
  const response = await apiRequest(`/task/${taskId}/tag/${encodedTag}`, {
    method: 'DELETE',
  });
  return response;
}

// Add a dependency (task waits on another task)
// depends_on: the task that must complete first
// dependency_of: the task that is blocked
// Only one of depends_on or dependency_of should be set
export async function addDependency(taskId, options = {}) {
  const body = {};
  if (options.depends_on) {
    body.depends_on = options.depends_on;
  } else if (options.dependency_of) {
    body.dependency_of = options.dependency_of;
  } else {
    throw new Error('Must specify either depends_on or dependency_of');
  }
  const response = await apiRequest(`/task/${taskId}/dependency`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response;
}

// Remove a dependency
export async function removeDependency(taskId, options = {}) {
  const params = new URLSearchParams();
  if (options.depends_on) {
    params.append('depends_on', options.depends_on);
  } else if (options.dependency_of) {
    params.append('dependency_of', options.dependency_of);
  } else {
    throw new Error('Must specify either depends_on or dependency_of');
  }
  const response = await apiRequest(`/task/${taskId}/dependency?${params.toString()}`, {
    method: 'DELETE',
  });
  return response;
}

// Add a task link (bidirectional link between tasks)
export async function addTaskLink(taskId, linksToTaskId) {
  const response = await apiRequest(`/task/${taskId}/link/${linksToTaskId}`, {
    method: 'POST',
  });
  return response;
}

// Remove a task link
export async function removeTaskLink(taskId, linksToTaskId) {
  const response = await apiRequest(`/task/${taskId}/link/${linksToTaskId}`, {
    method: 'DELETE',
  });
  return response;
}

// Get members with explicit access to a task
export async function getTaskMembers(taskId) {
  const response = await apiRequest(`/task/${taskId}/member`);
  return response.members || response;
}

// Set a custom field value on a task
export async function setCustomField(taskId, fieldId, value) {
  return apiRequest(`/task/${taskId}/field/${fieldId}`, {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

// Find a custom field on a task by name (case-insensitive partial match)
export async function findCustomFieldByName(taskId, fieldName) {
  const task = await getTask(taskId);
  const fields = task.custom_fields || [];
  const nameLower = fieldName.toLowerCase();

  // Exact match first
  const exact = fields.find(f => f.name.toLowerCase() === nameLower);
  if (exact) return exact;

  // Partial match
  const partial = fields.find(f => f.name.toLowerCase().includes(nameLower));
  return partial || null;
}
