#!/usr/bin/env node

/**
 * ClickUp - Task and Document interaction skill
 *
 * Task Commands:
 *   get <url|id>                  Get task details
 *   comments <url|id>             List task comments
 *   comment <url|id> "msg"        Post a comment
 *   status <url|id> "status"      Update task status
 *   tasks <list_id>               List tasks in a list
 *   me                            Show current user info
 *   create [list_id] "title"      Create a new task (list_id optional if default set)
 *   my-tasks                      List all tasks assigned to me
 *   search "query"                Search tasks across workspace
 *   assign <task> <user>          Assign task to user
 *   due <task> "date"             Set due date
 *   priority <task> <level>       Set priority (urgent/high/normal/low)
 *   subtask <task> "title"        Create a subtask
 *   move <task> <list_id>         Move task to different list
 *   link <task> <url> ["desc"]    Add external link reference
 *   checklist <task> "item"       Add checklist item
 *   delete-comment <comment_id>   Delete a comment
 *   watch <task> <user>           Add a watcher to task
 *   tag <task> "tag_name"         Add a tag to task
 *   description <task> "text"     Update task description (markdown supported)
 *
 * Document Commands:
 *   docs ["query"]                Search/list docs in workspace
 *   doc <doc_id>                  Get doc details and page listing
 *   create-doc "title"            Create a new doc
 *   page <doc_id> <page_id>       Get page content
 *   create-page <doc_id> "title"  Create a new page in a doc
 *   edit-page <doc_id> <page_id>  Edit a page's content
 *
 * Options:
 *   --json       Output raw JSON
 *   --subtasks   Include subtasks (for get command)
 *   --me         Filter to tasks assigned to me (for tasks command)
 *   --content    Page content for create-page/edit-page
 */

// API imports
import { loadEnv, appendToEnv } from './api/client.mjs';
import { getCurrentUser, getUserId, getTeamId, findUser } from './api/user.mjs';
import {
  getTask,
  getTasksInList,
  getAvailableStatuses,
  updateTaskStatus,
  updateTask,
  createTask,
  createSubtask,
  searchTasks,
  getMyTasks,
  assignTask,
  setDueDate,
  setPriority,
  moveTask,
  parseDateInput,
  addWatcher,
  addTag,
} from './api/tasks.mjs';
import { getComments, postComment, deleteComment } from './api/comments.mjs';
import { addChecklistItemToTask, getChecklists } from './api/checklists.mjs';
import { addExternalLink } from './api/links.mjs';
import {
  searchDocs,
  getDoc,
  createDoc,
  getDocPageListing,
  getPage,
  createPage,
  editPage,
} from './api/docs.mjs';

// Lib imports
import { parseTaskId, parseListId, parseDocId, parsePageId } from './lib/parse.mjs';
import {
  formatTask,
  formatTaskList,
  formatComments,
  formatDoc,
  formatDocList,
  formatPage,
  formatPageList,
} from './lib/format.mjs';

// Parse arguments
const args = process.argv.slice(2);
let command = null;
let targetInput = null;
let arg2 = null;
let arg3 = null;
let jsonOutput = false;
let includeSubtasks = false;
let filterMe = false;
let assigneeArg = null;
let dueArg = null;
let descriptionArg = null;
let contentArg = null;
let nameArg = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--subtasks') {
    includeSubtasks = true;
  } else if (arg === '--me') {
    filterMe = true;
  } else if (arg === '--assignee' || arg === '-a') {
    assigneeArg = args[++i];
  } else if (arg === '--due' || arg === '-d') {
    dueArg = args[++i];
  } else if (arg === '--description' || arg === '--desc') {
    descriptionArg = args[++i];
  } else if (arg === '--content' || arg === '-c') {
    contentArg = args[++i];
  } else if (arg === '--name' || arg === '-n') {
    nameArg = args[++i];
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

Task Commands:
  get <url|id>                  Get task details
  comments <url|id>             List task comments
  comment <url|id> "msg"        Post a comment
  status <url|id> "status"      Update task status
  tasks <list_id>               List tasks in a list
  me                            Show current user info
  create [list_id] "title"      Create a new task (list_id optional if default set)
  my-tasks                      List all tasks assigned to me
  search "query"                Search tasks across workspace
  assign <task> <user>          Assign task to user
  due <task> "date"             Set due date
  priority <task> <level>       Set priority (urgent/high/normal/low)
  subtask <task> "title"        Create a subtask
  move <task> <list_id>         Move task to different list
  link <task> <url> ["desc"]    Add external link reference
  checklist <task> "item"       Add checklist item
  delete-comment <comment_id>   Delete a comment
  watch <task> <user>           Add a watcher to task
  tag <task> "tag_name"         Add a tag to task
  description <task> "text"     Update task description (markdown supported)

Document Commands:
  docs ["query"]                Search/list docs in workspace
  doc <doc_id>                  Get doc details and page listing
  create-doc "title"            Create a new doc (--content for initial content)
  page <doc_id> <page_id>       Get page content
  create-page <doc_id> "title"  Add a new page to a doc (--content for body)
  edit-page <doc_id> <page_id>  Edit a page's content (--content and/or --name)

Options:
  --json       Output raw JSON
  --subtasks   Include subtasks (for get command)
  --me         Filter to tasks assigned to me (for tasks command)
  --content    Page content for create-page/edit-page (markdown)
  --name       New name for edit-page

Examples:
  node query.mjs get 86a1b2c3d --subtasks
  node query.mjs comment 86a1b2c3d "Starting work on this"
  node query.mjs status 86a1b2c3d "in progress"
  node query.mjs tasks 901111220963 --me
  node query.mjs create 901111220963 "New feature: dark mode"
  node query.mjs create "Quick task" (uses CLICKUP_DEFAULT_LIST_ID)
  node query.mjs my-tasks
  node query.mjs search "dark mode"
  node query.mjs assign 86a1b2c3d justin
  node query.mjs due 86a1b2c3d "tomorrow"
  node query.mjs priority 86a1b2c3d high
  node query.mjs subtask 86a1b2c3d "Write unit tests"
  node query.mjs move 86a1b2c3d 901111220964
  node query.mjs link 86a1b2c3d "https://github.com/..." "PR #123"
  node query.mjs checklist 86a1b2c3d "Review code"
  node query.mjs delete-comment 90110200841741
  node query.mjs watch 86a1b2c3d koen
  node query.mjs tag 86a1b2c3d "DevOps"
  node query.mjs description 86a1b2c3d "## Summary\\nThis is **bold** text"

Document Examples:
  node query.mjs docs                                     # List all docs
  node query.mjs docs "API"                               # Search docs
  node query.mjs doc abc123                               # Get doc details
  node query.mjs create-doc "Project Notes"               # Create empty doc
  node query.mjs create-doc "Guide" --content "# Guide\\nContent here"  # Doc with content
  node query.mjs page abc123 page456                      # Get page content
  node query.mjs create-page abc123 "New Section"         # Add additional page
  node query.mjs edit-page abc123 page456 --content "Updated content" --name "Renamed"`);
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

  // Document commands that may not require a target
  if (command === 'docs') {
    try {
      const workspaceId = await getTeamId();
      const options = targetInput ? { query: targetInput } : {};
      const docs = await searchDocs(workspaceId, options);
      if (jsonOutput) {
        console.log(JSON.stringify(docs, null, 2));
      } else {
        if (docs.length === 0) {
          console.log(targetInput ? `No docs found matching "${targetInput}"` : 'No docs found.');
        } else {
          console.log(formatDocList(docs));
        }
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  if (command === 'create-doc') {
    if (!targetInput) {
      console.error('Error: Doc title required');
      console.error('Usage: node query.mjs create-doc "Doc Title" [--content "content"]');
      process.exit(1);
    }
    try {
      const workspaceId = await getTeamId();
      const options = {};
      if (contentArg) {
        options.content = contentArg;
      }
      const doc = await createDoc(workspaceId, targetInput, options);
      if (jsonOutput) {
        console.log(JSON.stringify(doc, null, 2));
      } else {
        console.log(`Doc created: ${doc.name}`);
        console.log(`ID: ${doc.id}`);
        if (doc.firstPageId) {
          console.log(`First page populated with content`);
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
        // Support: create <list_id> "title" [options] OR create "title" [options] (uses default list)
        // Options: --assignee/-a <user>, --due/-d <date>, --description/--desc <text>
        let listId = parseListId(targetInput);
        let title = arg2;

        // If targetInput doesn't parse as a list ID, treat it as the title
        if (!listId) {
          title = targetInput;
          listId = process.env.CLICKUP_DEFAULT_LIST_ID;
          if (!listId) {
            console.error('Error: No list ID provided and CLICKUP_DEFAULT_LIST_ID not set');
            console.error('Usage: node query.mjs create <list_id> "Task title" [options]');
            console.error('   Or: Set CLICKUP_DEFAULT_LIST_ID in .env to use: node query.mjs create "Task title"');
            console.error('Options: --assignee/-a <user>, --due/-d <date>, --description/--desc <text>');
            process.exit(1);
          }
        }

        if (!title) {
          console.error('Error: Task title required');
          console.error('Usage: node query.mjs create <list_id> "Task title" [options]');
          console.error('Options: --assignee/-a <user>, --due/-d <date>, --description/--desc <text>');
          process.exit(1);
        }

        // Build options from flags
        const options = {};
        if (descriptionArg) {
          // Use markdown_description for proper markdown rendering in ClickUp
          // Note: Task descriptions use markdown_description (ClickUp parses),
          // while comments use JSON array format (we parse via markdownToClickUp)
          options.markdown_description = descriptionArg;
        }
        if (dueArg) {
          const dueDate = parseDateInput(dueArg);
          options.due_date = dueDate.getTime();
        }
        if (assigneeArg) {
          let assigneeId;
          if (assigneeArg.toLowerCase() === 'me') {
            // Special case: "me" means the current authenticated user
            assigneeId = await getUserId();
          } else {
            const teamId = await getTeamId();
            const user = await findUser(teamId, assigneeArg);
            if (!user) {
              console.error(`Error: User "${assigneeArg}" not found in team`);
              process.exit(1);
            }
            assigneeId = user.id;
          }
          options.assignees = [assigneeId];
        }

        const task = await createTask(listId, title, options);
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`Task created: ${task.name}`);
          console.log(`ID: ${task.id}`);
          if (task.assignees?.length) {
            console.log(`Assignees: ${task.assignees.map(a => a.username).join(', ')}`);
          }
          if (task.due_date) {
            console.log(`Due: ${new Date(parseInt(task.due_date, 10)).toLocaleDateString()}`);
          }
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

      case 'delete-comment': {
        const commentId = targetInput;
        if (!commentId) {
          console.error('Error: Comment ID required');
          console.error('Usage: node query.mjs delete-comment <comment_id>');
          process.exit(1);
        }
        await deleteComment(commentId);
        if (jsonOutput) {
          console.log(JSON.stringify({ deleted: true, commentId }, null, 2));
        } else {
          console.log(`Comment ${commentId} deleted`);
        }
        break;
      }

      case 'watch': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: User required');
          console.error('Usage: node query.mjs watch <task> <user>');
          process.exit(1);
        }
        const teamId = await getTeamId();
        const user = await findUser(teamId, arg2);
        if (!user) {
          console.error(`Error: User "${arg2}" not found in team`);
          process.exit(1);
        }
        // ClickUp API v2 doesn't support adding watchers programmatically.
        // Post a comment with @mention as an alternative to notify the user.
        const mentionComment = `@${user.username} has been added as a watcher on this task.`;
        const result = await postComment(taskId, mentionComment);
        if (jsonOutput) {
          console.log(JSON.stringify({ notified: true, user: user.username, comment_id: result.id }, null, 2));
        } else {
          console.log(`Notified ${user.username || user.email} via @mention comment`);
          console.log(`(Note: ClickUp API does not support adding watchers directly)`);
        }
        break;
      }

      case 'tag': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Tag name required');
          console.error('Usage: node query.mjs tag <task> "tag_name"');
          process.exit(1);
        }
        await addTag(taskId, arg2);
        if (jsonOutput) {
          console.log(JSON.stringify({ tagged: true, taskId, tag: arg2 }, null, 2));
        } else {
          console.log(`Tag "${arg2}" added to task`);
        }
        break;
      }

      case 'description': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Description text required');
          console.error('Usage: node query.mjs description <task> "description text"');
          console.error('Markdown formatting is supported.');
          process.exit(1);
        }
        // Use markdown_description for proper markdown rendering in ClickUp
        // Note: Unlike comments (which use JSON array format via markdownToClickUp),
        // task descriptions use ClickUp's native markdown_description field
        const task = await updateTask(taskId, { markdown_description: arg2 });
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log('Task description updated');
          console.log(`URL: ${task.url}`);
        }
        break;
      }

      // Document commands
      case 'doc': {
        const docId = parseDocId(targetInput);
        if (!docId) {
          console.error('Error: Could not parse doc ID from input');
          process.exit(1);
        }
        const workspaceId = await getTeamId();
        const doc = await getDoc(workspaceId, docId);
        const pages = await getDocPageListing(workspaceId, docId);
        if (jsonOutput) {
          console.log(JSON.stringify({ doc, pages }, null, 2));
        } else {
          console.log(formatDoc(doc));
          console.log('');
          console.log('Pages:');
          console.log(formatPageList(pages));
        }
        break;
      }

      case 'page': {
        const docId = parseDocId(targetInput);
        if (!docId) {
          console.error('Error: Could not parse doc ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Page ID required');
          console.error('Usage: node query.mjs page <doc_id> <page_id>');
          process.exit(1);
        }
        const pageId = parsePageId(arg2);
        const workspaceId = await getTeamId();
        const page = await getPage(workspaceId, docId, pageId);
        if (jsonOutput) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          console.log(formatPage(page));
        }
        break;
      }

      case 'create-page': {
        const docId = parseDocId(targetInput);
        if (!docId) {
          console.error('Error: Could not parse doc ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Page title required');
          console.error('Usage: node query.mjs create-page <doc_id> "Page Title" [--content "content"]');
          process.exit(1);
        }
        const workspaceId = await getTeamId();
        const options = {};
        if (contentArg) {
          options.content = contentArg;
        }
        const page = await createPage(workspaceId, docId, arg2, options);
        if (jsonOutput) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          console.log(`Page created: ${page.name}`);
          console.log(`ID: ${page.id}`);
        }
        break;
      }

      case 'edit-page': {
        const docId = parseDocId(targetInput);
        if (!docId) {
          console.error('Error: Could not parse doc ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Page ID required');
          console.error('Usage: node query.mjs edit-page <doc_id> <page_id> [--content "content"] [--name "name"]');
          process.exit(1);
        }
        if (!contentArg && !nameArg) {
          console.error('Error: At least --content or --name is required');
          console.error('Usage: node query.mjs edit-page <doc_id> <page_id> [--content "content"] [--name "name"]');
          process.exit(1);
        }
        const pageId = parsePageId(arg2);
        const workspaceId = await getTeamId();
        const updates = {};
        if (contentArg) {
          updates.content = contentArg;
        }
        if (nameArg) {
          updates.name = nameArg;
        }
        const page = await editPage(workspaceId, docId, pageId, updates);
        if (jsonOutput) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          console.log('Page updated successfully');
          if (page.id) {
            console.log(`ID: ${page.id}`);
          }
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
