#!/usr/bin/env node

/**
 * ClickUp - Task interaction skill
 *
 * Commands:
 *   get <url|id>                  Get task details
 *   comments <url|id>             List task comments
 *   comment <url|id> "msg"        Post a comment
 *   status <url|id> "status"      Update task status
 *   tasks <list_id>               List tasks in a list
 *   me                            Show current user info
 *   create <list_id> "title"      Create a new task
 *   my-tasks                      List all tasks assigned to me
 *   search "query"                Search tasks across workspace
 *   assign <task> <user>          Assign task to user
 *   due <task> "date"             Set due date
 *   priority <task> <level>       Set priority (urgent/high/normal/low)
 *   subtask <task> "title"        Create a subtask
 *   move <task> <list_id>         Move task to different list
 *   link <task> <url> ["desc"]    Add external link reference
 *   checklist <task> "item"       Add checklist item
 *
 * Options:
 *   --json       Output raw JSON
 *   --subtasks   Include subtasks (for get command)
 *   --me         Filter to tasks assigned to me (for tasks command)
 */

// API imports
import { loadEnv, appendToEnv } from './api/client.mjs';
import { getCurrentUser, getUserId, getTeamId, findUser } from './api/user.mjs';
import {
  getTask,
  getTasksInList,
  getAvailableStatuses,
  updateTaskStatus,
  createTask,
  createSubtask,
  searchTasks,
  getMyTasks,
  assignTask,
  setDueDate,
  setPriority,
  moveTask,
} from './api/tasks.mjs';
import { getComments, postComment } from './api/comments.mjs';
import { addChecklistItemToTask, getChecklists } from './api/checklists.mjs';
import { addExternalLink } from './api/links.mjs';

// Lib imports
import { parseTaskId, parseListId } from './lib/parse.mjs';
import { formatTask, formatTaskList, formatComments } from './lib/format.mjs';

// Parse arguments
const args = process.argv.slice(2);
let command = null;
let targetInput = null;
let arg2 = null;
let arg3 = null;
let jsonOutput = false;
let includeSubtasks = false;
let filterMe = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--subtasks') {
    includeSubtasks = true;
  } else if (arg === '--me') {
    filterMe = true;
  } else if (!command) {
    command = arg;
  } else if (!targetInput) {
    targetInput = arg;
  } else if (!arg2) {
    arg2 = arg;
  } else if (!arg3) {
    arg3 = arg;
  }
}

// Backward compatibility
const commentText = arg2;

// Show usage
function showUsage() {
  console.error(`Usage: node query.mjs <command> [options]

Commands:
  get <url|id>                  Get task details
  comments <url|id>             List task comments
  comment <url|id> "msg"        Post a comment
  status <url|id> "status"      Update task status
  tasks <list_id>               List tasks in a list
  me                            Show current user info
  create <list_id> "title"      Create a new task
  my-tasks                      List all tasks assigned to me
  search "query"                Search tasks across workspace
  assign <task> <user>          Assign task to user
  due <task> "date"             Set due date
  priority <task> <level>       Set priority (urgent/high/normal/low)
  subtask <task> "title"        Create a subtask
  move <task> <list_id>         Move task to different list
  link <task> <url> ["desc"]    Add external link reference
  checklist <task> "item"       Add checklist item

Options:
  --json       Output raw JSON
  --subtasks   Include subtasks (for get command)
  --me         Filter to tasks assigned to me (for tasks command)

Examples:
  node query.mjs get 86a1b2c3d --subtasks
  node query.mjs comment 86a1b2c3d "Starting work on this"
  node query.mjs status 86a1b2c3d "in progress"
  node query.mjs tasks 901111220963 --me
  node query.mjs create 901111220963 "New feature: dark mode"
  node query.mjs my-tasks
  node query.mjs search "dark mode"
  node query.mjs assign 86a1b2c3d justin
  node query.mjs due 86a1b2c3d "tomorrow"
  node query.mjs priority 86a1b2c3d high
  node query.mjs subtask 86a1b2c3d "Write unit tests"
  node query.mjs move 86a1b2c3d 901111220964
  node query.mjs link 86a1b2c3d "https://github.com/..." "PR #123"
  node query.mjs checklist 86a1b2c3d "Review code"`);
  process.exit(1);
}

async function main() {
  // Load environment
  loadEnv();

  if (!command) {
    showUsage();
  }

  // Handle commands that don't require target input
  if (command === 'me') {
    try {
      const user = await getCurrentUser();
      if (jsonOutput) {
        console.log(JSON.stringify(user, null, 2));
      } else {
        console.log(`User: ${user.username}`);
        console.log(`Email: ${user.email}`);
        console.log(`ID: ${user.id}`);
        console.log(`Timezone: ${user.timezone || 'Not set'}`);
      }

      // Cache user ID if not already cached
      if (!process.env.CLICKUP_USER_ID) {
        appendToEnv('CLICKUP_USER_ID', user.id.toString(), `User: ${user.username} (auto-detected)`);
        console.error('\nCached user ID to .env');
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  if (command === 'my-tasks') {
    try {
      const teamId = await getTeamId();
      const userId = await getUserId();
      const tasks = await getMyTasks(teamId, userId);
      if (jsonOutput) {
        console.log(JSON.stringify(tasks, null, 2));
      } else {
        console.log(formatTaskList(tasks));
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  if (command === 'search') {
    if (!targetInput) {
      console.error('Error: Search query required');
      console.error('Usage: node query.mjs search "query"');
      process.exit(1);
    }
    try {
      const teamId = await getTeamId();
      const tasks = await searchTasks(teamId, targetInput);
      if (jsonOutput) {
        console.log(JSON.stringify(tasks, null, 2));
      } else {
        if (tasks.length === 0) {
          console.log(`No tasks found matching "${targetInput}"`);
        } else {
          console.log(formatTaskList(tasks));
        }
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  // All other commands require a target
  if (!targetInput) {
    showUsage();
  }

  try {
    switch (command) {
      case 'get': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        const task = await getTask(taskId, includeSubtasks);
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(formatTask(task));
        }
        break;
      }

      case 'comments': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        const comments = await getComments(taskId);
        if (jsonOutput) {
          console.log(JSON.stringify(comments, null, 2));
        } else {
          console.log(formatComments(comments));
        }
        break;
      }

      case 'comment': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!commentText) {
          console.error('Error: Comment text required');
          console.error('Usage: node query.mjs comment <url|id> "Your comment"');
          process.exit(1);
        }
        const result = await postComment(taskId, commentText);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Comment posted successfully (ID: ${result.id})`);
        }
        break;
      }

      case 'status': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!commentText) {
          // No status provided - show available statuses
          const statuses = await getAvailableStatuses(taskId);
          console.log('Available statuses:');
          for (const s of statuses) {
            console.log(`  - "${s.status}" (${s.type})`);
          }
          break;
        }
        const { task, matchedStatus } = await updateTaskStatus(taskId, commentText);
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`Status updated to "${matchedStatus.status}"`);
        }
        break;
      }

      case 'tasks': {
        const listId = parseListId(targetInput);
        if (!listId) {
          console.error('Error: Could not parse list ID from input');
          process.exit(1);
        }

        let assigneeId = null;
        if (filterMe) {
          assigneeId = await getUserId();
        }

        const tasks = await getTasksInList(listId, assigneeId);
        if (jsonOutput) {
          console.log(JSON.stringify(tasks, null, 2));
        } else {
          console.log(formatTaskList(tasks));
        }
        break;
      }

      case 'create': {
        const listId = parseListId(targetInput);
        if (!listId) {
          console.error('Error: Could not parse list ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Task title required');
          console.error('Usage: node query.mjs create <list_id> "Task title"');
          process.exit(1);
        }
        const task = await createTask(listId, arg2);
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`Task created: ${task.name}`);
          console.log(`ID: ${task.id}`);
          console.log(`URL: ${task.url}`);
        }
        break;
      }

      case 'assign': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: User required');
          console.error('Usage: node query.mjs assign <task> <user>');
          process.exit(1);
        }
        const teamId = await getTeamId();
        const user = await findUser(teamId, arg2);
        if (!user) {
          console.error(`Error: User "${arg2}" not found in team`);
          process.exit(1);
        }
        const task = await assignTask(taskId, [user.id]);
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`Task assigned to ${user.username || user.email}`);
        }
        break;
      }

      case 'due': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Due date required');
          console.error('Usage: node query.mjs due <task> "date"');
          console.error('Examples: "tomorrow", "next friday", "2024-01-15", "+3d"');
          process.exit(1);
        }
        const task = await setDueDate(taskId, arg2);
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          const dueDate = task.due_date ? new Date(parseInt(task.due_date, 10)).toLocaleDateString() : 'cleared';
          console.log(`Due date set to: ${dueDate}`);
        }
        break;
      }

      case 'priority': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Priority level required');
          console.error('Usage: node query.mjs priority <task> <level>');
          console.error('Levels: urgent, high, normal, low, none');
          process.exit(1);
        }
        const { task, priority } = await setPriority(taskId, arg2);
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`Priority set to: ${priority}`);
        }
        break;
      }

      case 'subtask': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Subtask title required');
          console.error('Usage: node query.mjs subtask <task> "Subtask title"');
          process.exit(1);
        }
        const subtask = await createSubtask(taskId, arg2);
        if (jsonOutput) {
          console.log(JSON.stringify(subtask, null, 2));
        } else {
          console.log(`Subtask created: ${subtask.name}`);
          console.log(`ID: ${subtask.id}`);
          console.log(`URL: ${subtask.url}`);
        }
        break;
      }

      case 'move': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Target list ID required');
          console.error('Usage: node query.mjs move <task> <list_id>');
          process.exit(1);
        }
        const listId = parseListId(arg2);
        const task = await moveTask(taskId, listId);
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`Task moved successfully`);
          console.log(`URL: ${task.url}`);
        }
        break;
      }

      case 'link': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: URL required');
          console.error('Usage: node query.mjs link <task> <url> ["description"]');
          process.exit(1);
        }
        const result = await addExternalLink(taskId, arg2, arg3);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Link added as comment (ID: ${result.id})`);
        }
        break;
      }

      case 'checklist': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Checklist item required');
          console.error('Usage: node query.mjs checklist <task> "Item text"');
          process.exit(1);
        }
        const { checklist, item } = await addChecklistItemToTask(taskId, arg2);
        if (jsonOutput) {
          console.log(JSON.stringify({ checklist, item }, null, 2));
        } else {
          console.log(`Added to checklist "${checklist.name}"`);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        showUsage();
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
