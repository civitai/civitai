#!/usr/bin/env node

/**
 * ClickUp - Task and Document interaction skill
 *
 * Task Commands:
 *   get <url|id>                  Get task details
 *   comments <url|id>             List task comments (--threads to expand)
 *   thread <comment_id>           View threaded replies on a comment
 *   reply <comment_id> "msg"      Reply to a comment thread
 *   comment <url|id> "msg"        Post a comment
 *   status <url|id> "status"      Update task status
 *   tasks <list_id>               List tasks in a list
 *   me                            Show current user info
 *   create [list_id] "title"      Create a new task (list_id optional if default set)
 *   my-tasks                      List all tasks assigned to me
 *   search [query]                Search tasks — requires a scope: --list, --folder, --me,
 *                                 --assignee, --status, or --all. Text query optional.
 *   find-list "name"              Find lists/folders by name (fast structural walk, no task fetch)
 *   assign <task> <user>          Assign task to user
 *   due <task> "date"             Set due date
 *   start <task> "date"           Set start date
 *   schedule <task> "start" "due" Set both start and due dates
 *   rename <task> "new name"      Rename a task
 *   priority <task> <level>       Set priority (urgent/high/normal/low)
 *   subtask <task> "title"        Create a subtask
 *   move <task> <list_id>         Move task to different list
 *   link <task> <url> ["desc"]    Add external link reference
 *   checklist <task> "item"       Add checklist item
 *   update-comment <comment_id> "text"  Update a comment's text
 *   resolve-comment <comment_id>  Resolve/close a comment
 *   delete-comment <comment_id>   Delete a comment
 *   watch <task> <user>           Add a watcher to task
 *   unwatch <task> <user>         Remove a watcher from task
 *   tag <task> "tag_name"         Add a tag to task
 *   remove-tag <task> "tag_name"  Remove a tag from task
 *   description <task> "text"     Update task description (markdown supported)
 *   depends <task> <other_task>   Set task as waiting on another task
 *   blocks <task> <other_task>    Set task as blocking another task
 *   task-link <task> <other>      Create bidirectional link between tasks
 *   archive <task>                Archive a task
 *   unarchive <task>              Restore an archived task
 *   claim <task>                  Link your session to a task (sets Session ID custom field)
 *
 * List Commands:
 *   list <list_id>                Get list details
 *   lists <folder_id>             List all lists in a folder
 *   space-lists <space_id>        List folderless lists in a space
 *   create-list <space> "name"    Create a new list in a space
 *   update-list <list_id>         Update list (--name, --content)
 *   delete-list <list_id>         Delete a list
 *
 * Document Commands:
 *   docs ["query"]                Search/list docs in workspace
 *   doc <doc_id>                  Get doc details and page listing
 *   create-doc "title"            Create a new doc (--space to place in space)
 *   page <doc_id> <page_id>       Get page content
 *   create-page <doc_id> "title"  Create a new page in a doc
 *   edit-page <doc_id> <page_id>  Edit a page's content
 *
 * Attachment Commands:
 *   attach <url|id> --file <path> Upload file attachment(s) to a task
 *   fetch-image <url>             Download attachment to local temp file (--output path)
 *
 * Options:
 *   --json       Output raw JSON
 *   --subtasks   Include subtasks (for get command)
 *   --me         Filter to tasks assigned to me (for tasks command)
 *   --content    Inline content (for short text)
 *   --file       Read content from a file path (preferred for long content)
 *   --cleanup    Delete --file after successful execution
 *   --parent     Parent page ID for create-page (creates subpage)
 */

import { readFileSync, existsSync, unlinkSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir, homedir } from 'os';

// API imports
import { initClient, getActiveCredentials, getActiveAccountId } from './api/client.mjs';
import { updateAccountField, listAccounts as listAccountsFn, setDefaultAccount, addAccount as addAccountFn, removeAccount as removeAccountFn } from './lib/accounts.mjs';
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
  setStartDate,
  setDates,
  setPriority,
  moveTask,
  parseDateInput,
  addWatcher,
  addTag,
  addDependency,
  removeDependency,
  addTaskLink,
  removeTaskLink,
  archiveTask,
  unarchiveTask,
  removeWatcher,
  removeTag,
  setCustomField,
  findCustomFieldByName,
} from './api/tasks.mjs';
import { getComments, postComment, updateComment, deleteComment, getThreadedComments, replyToComment } from './api/comments.mjs';
import { addChecklistItemToTask, getChecklists, editChecklistItem, deleteChecklistItem } from './api/checklists.mjs';
import { addExternalLink } from './api/links.mjs';
import { getList, createList, deleteList, updateList, getLists, getFolderlessLists, getListMembers, findListByName } from './api/lists.mjs';
import {
  searchDocs,
  getDoc,
  createDoc,
  getDocPageListing,
  getPage,
  createPage,
  editPage,
} from './api/docs.mjs';
import { uploadAttachment, uploadAttachments } from './api/attachments.mjs';
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  addWatcherEntry,
  removeWatcherEntry,
  getWatcherEntries,
  clearAllWatcherEntries,
  DEFAULT_TASK_EVENTS,
  DEFAULT_LIST_EVENTS,
  DEFAULT_SPACE_EVENTS,
} from './api/webhooks.mjs';

// Lib imports
import { executeBatchCreate } from './lib/batch-create.mjs';
import { splitIds, isBulk, bulkExecute, formatBulkResults } from './lib/bulk.mjs';
import { parseTaskId, parseListId, parseDocId, parsePageId, parseSpaceId } from './lib/parse.mjs';
import {
  formatTask,
  formatTaskList,
  formatComments,
  formatThread,
  formatDoc,
  formatDocList,
  formatPage,
  formatPageList,
  formatList,
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
let parentArg = null;
let spaceArg = null;
let fileArg = null;
let cleanupFlag = false;
let archiveFlag = false;
let pageArg = null;
let accountArg = null;
let threadsFlag = false;
let attachArgs = [];
let eventsArg = null;
let listScopeArg = null;
let folderScopeArg = null;
let statusScopeArg = null;
let allScopeFlag = false;

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
  } else if (arg === '--file' || arg === '-f') {
    fileArg = args[++i];
  } else if (arg === '--cleanup') {
    cleanupFlag = true;
  } else if (arg === '--archive') {
    archiveFlag = true;
  } else if (arg === '--name' || arg === '-n') {
    nameArg = args[++i];
  } else if (arg === '--parent' || arg === '-p') {
    parentArg = args[++i];
  } else if (arg === '--space' || arg === '-s') {
    spaceArg = args[++i];
  } else if (arg === '--page') {
    pageArg = args[++i];
  } else if (arg === '--threads' || arg === '-t') {
    threadsFlag = true;
  } else if (arg === '--attach') {
    attachArgs.push(args[++i]);
  } else if (arg === '--events' || arg === '-e') {
    eventsArg = args[++i];
  } else if (arg === '--account') {
    accountArg = args[++i];
  } else if (arg === '--list') {
    listScopeArg = args[++i];
  } else if (arg === '--folder') {
    folderScopeArg = args[++i];
  } else if (arg === '--status') {
    statusScopeArg = args[++i];
  } else if (arg === '--all') {
    allScopeFlag = true;
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

// Unescape literal \n and \t in text args (CLI passes them as-is)
function unescapeText(str) {
  return str ? str.replace(/\\n/g, '\n').replace(/\\t/g, '\t') : str;
}

function detectClaudeSessionId() {
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  // Fallback: the active Claude Code session is the one currently writing to its
  // jsonl transcript. Find the most-recently-modified jsonl across every project
  // dir under ~/.claude/projects/. We can't key off process.cwd() because the
  // caller may have cd'd into a skill dir before invoking node.
  try {
    const root = join(homedir(), '.claude', 'projects');
    if (!existsSync(root)) return null;
    let freshest = null;
    for (const projectName of readdirSync(root)) {
      const projectDir = join(root, projectName);
      try {
        if (!statSync(projectDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of readdirSync(projectDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const mtime = statSync(join(projectDir, f)).mtimeMs;
        if (!freshest || mtime > freshest.mtime) {
          freshest = { id: f.replace(/\.jsonl$/, ''), mtime };
        }
      }
    }
    // Only trust the pick if it was written within the last 60s — otherwise
    // it's stale and could belong to any old session.
    if (!freshest || Date.now() - freshest.mtime > 60_000) return null;
    return freshest.id;
  } catch {
    return null;
  }
}
contentArg = unescapeText(contentArg);
descriptionArg = unescapeText(descriptionArg);
arg2 = unescapeText(arg2);

// --file overrides --content: read file contents as the content/text argument
if (fileArg) {
  const filePath = resolve(fileArg);
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }
  const fileContent = readFileSync(filePath, 'utf-8');
  contentArg = fileContent;
  // Also set arg2 so commands that use positional text (comment, description) pick it up
  if (!arg2) arg2 = fileContent;
}

// Backward compatibility (commentText = arg2, which --file may have populated)
const commentText = arg2;

// Show usage
function showUsage() {
  console.error(`Usage: node query.mjs <command> [options]

Task Commands:
  get <url|id>                  Get task details
  comments <url|id>             List task comments (--threads to expand)
  thread <comment_id>           View threaded replies on a comment
  reply <comment_id> "msg"      Reply to a comment thread
  comment <url|id> "msg"        Post a comment
  status <url|id> "status"      Update task status
  tasks <list_id>               List tasks in a list
  me                            Show current user info
  create [list_id] "title"      Create a new task (list_id optional if default set)
  my-tasks                      List all tasks assigned to me
  search [query]                Search tasks — requires a scope flag (--list/--folder/--me/
                                --assignee/--status) or --all. Text query optional.
  find-list "name"              Find a list or folder by name (fast, structural only)
  assign <task> <user>          Assign task to user
  due <task> "date"             Set due date
  start <task> "date"           Set start date
  schedule <task> "start" "due" Set both start and due dates
  rename <task> "new name"      Rename a task
  priority <task> <level>       Set priority (urgent/high/normal/low)
  subtask <task> "title"        Create a subtask
  move <task> <list_id>         Move task to different list
  link <task> <url> ["desc"]    Add external link reference
  checklist <task> "item"       Add checklist item
  update-comment <comment_id> "text"  Update a comment's text
  resolve-comment <comment_id>  Resolve/close a comment
  delete-comment <comment_id>   Delete a comment
  watch <task> <user>           Add a watcher to task
  unwatch <task> <user>         Remove a watcher from task
  tag <task> "tag_name"         Add a tag to task
  remove-tag <task> "tag_name"  Remove a tag from task
  description <task> "text"     Update task description (markdown supported)
  depends <task> <other_task>   Set task as waiting on another task
  blocks <task> <other_task>    Set task as blocking another task
  task-link <task> <other>      Create bidirectional link between tasks
  archive <task>                Archive a task (remove from active views)
  unarchive <task>              Restore an archived task
  claim <task>                  Link your session to this task (for resumability)

List Commands:
  list <list_id>                Get list details
  lists <folder_id>             List all lists in a folder
  space-lists <space_id>        List folderless lists in a space
  create-list <space> "name"    Create a new list in a space (--content for description)
  update-list <list_id>         Update list (--name "new name", --content "description")
  delete-list <list_id>         Delete a list

Document Commands:
  docs ["query"]                Search/list docs in workspace
  doc <doc_id>                  Get doc details and page listing
  create-doc "title"            Create a new doc (--content, --space)
  page <doc_id> <page_id>       Get page content
  create-page <doc_id> "title"  Add a new page to a doc (--content, --parent)
  edit-page <doc_id> <page_id>  Edit a page's content (--content and/or --name)

Attachment Commands:
  attach <url|id>               Upload file(s) to a task (--attach path, repeatable)
  fetch-image <url>             Download attachment to local temp file (--output path)

Project Setup:
  batch-create --file plan.json  Create multiple tasks from JSON (with deps, subtasks, assignments)
  batch-create --file plan.json --dry-run  Preview without creating

Watcher Commands (webhook-based event monitoring):
  watch-task <id>[,id2,...]     Watch task(s) for events (--events to customize)
  watch-list <list_id>          Watch a list for events
  watch-space <space_id>        Watch a space for events
  watchers                      List active webhook watchers
  webhooks                      List all webhooks in workspace (from API)
  unwatch-webhook <wh_id>       Delete a webhook watcher
  unwatch-webhook --all         Delete all webhook watchers

  Listener (run as background task):
  node listen.mjs [--timeout 600] [--port 3458] [--mode wait|server]

Account Commands:
  accounts                      List configured accounts
  switch-account <name>         Change the default account
  add-account <name>            Add a new account (--token required)
  remove-account <name>         Remove an account

Options:
  --account  <name>  Use a specific account for this command
  --json       Output raw JSON
  --subtasks   Include subtasks (for get command)
  --me         Filter to tasks assigned to me (for tasks command)
  --content    Inline content (markdown). For short text only.
  --file       Read content from a file path (preferred for long content)
  --cleanup    Delete the --file after successful execution
  --name       New name for edit-page
  --parent     Parent page ID for create-page (creates as subpage)
  --attach     File path to upload as attachment (repeatable, for attach/comment)
  --space      Space ID for create-doc (places doc in that space)
  --events     Comma-separated event types for watch commands (e.g. taskStatusUpdated,taskCommentPosted)

Bulk Operations (comma-separated IDs):
  node query.mjs get id1,id2,id3              Fetch multiple tasks at once
  node query.mjs status id1,id2 "complete"    Update status on multiple tasks
  node query.mjs due id1,id2 "friday"         Set due date on multiple tasks

Examples:
  node query.mjs get 86a1b2c3d --subtasks
  node query.mjs comment 86a1b2c3d "Starting work on this"
  node query.mjs status 86a1b2c3d "in progress"
  node query.mjs tasks 901111220963 --me
  node query.mjs create 901111220963 "New feature: dark mode"
  node query.mjs create "Quick task" (uses CLICKUP_DEFAULT_LIST_ID)
  node query.mjs my-tasks
  node query.mjs search "dark mode" --list 901111220963
  node query.mjs search --me --status "in progress"
  node query.mjs search "bug" --all                       # full-workspace scan (slow)
  node query.mjs find-list "Red Launch"                   # locate a list/folder by name
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

List Examples:
  node query.mjs list 901111220963                        # Get list details
  node query.mjs create-list 20128955 "New List"          # Create list in space
  node query.mjs create-list "https://app.clickup.com/.../v/s/20128955" "New List"
  node query.mjs delete-list 901111220963                 # Delete a list

Document Examples:
  node query.mjs docs                                     # List all docs
  node query.mjs docs "API"                               # Search docs
  node query.mjs doc abc123                               # Get doc details
  node query.mjs create-doc "Project Notes"               # Create empty doc
  node query.mjs create-doc "Guide" --content "# Guide\\nContent here"  # Short inline content
  node query.mjs page abc123 page456                      # Get page content
  node query.mjs create-page abc123 "New Section"         # Add additional page
  node query.mjs edit-page abc123 page456 --content "Updated content" --name "Renamed"

File-based Content (recommended for anything longer than a sentence):
  node query.mjs create-doc "Spec" --file ./spec.md --space 90114072520
  node query.mjs edit-page abc123 p456 --file ./updated-content.md
  node query.mjs comment 86a1b2c3d --file ./review-notes.md
  node query.mjs description 86a1b2c3d --file ./task-description.md
  node query.mjs create-doc "Temp" --file ./draft.md --cleanup  # Deletes draft.md after
`);
  process.exit(1);
}

async function main() {
  // Account management commands (run before initClient since they manage the config)
  if (command === 'accounts') {
    const accounts = listAccountsFn();
    if (accounts.length === 0) {
      console.log('No accounts configured. Create accounts.json or .env in the skill directory.');
    } else {
      for (const a of accounts) {
        const marker = a.isDefault ? ' (default)' : '';
        const token = a.hasApiToken ? 'token' : 'no-token';
        const jwt = a.hasJwt ? ', jwt' : '';
        console.log(`  ${a.id}${marker} [${token}${jwt}]${a.email ? ` - ${a.email}` : ''}`);
      }
    }
    return;
  }

  if (command === 'switch-account') {
    if (!targetInput) {
      console.error('Error: Account name required');
      console.error('Usage: node query.mjs switch-account <name>');
      process.exit(1);
    }
    setDefaultAccount(targetInput);
    console.log(`Default account set to: ${targetInput}`);
    return;
  }

  if (command === 'add-account') {
    if (!targetInput) {
      console.error('Error: Account name required');
      console.error('Usage: node query.mjs add-account <name> --token pk_...');
      process.exit(1);
    }
    // Look for --token in remaining args
    let token = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--token' && args[i + 1]) {
        token = args[i + 1];
        break;
      }
    }
    if (!token) {
      console.error('Error: --token is required');
      console.error('Usage: node query.mjs add-account <name> --token pk_...');
      process.exit(1);
    }
    addAccountFn(targetInput, { apiToken: token });
    console.log(`Account "${targetInput}" added.`);
    return;
  }

  if (command === 'remove-account') {
    if (!targetInput) {
      console.error('Error: Account name required');
      console.error('Usage: node query.mjs remove-account <name>');
      process.exit(1);
    }
    removeAccountFn(targetInput);
    console.log(`Account "${targetInput}" removed.`);
    return;
  }

  // Initialize client with selected account
  initClient(accountArg);

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
      const creds = getActiveCredentials();
      if (!creds.userId) {
        updateAccountField(getActiveAccountId(), 'userId', user.id.toString());
        console.error('\nCached user ID to accounts.json');
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
    const hasScope = !!(listScopeArg || folderScopeArg || statusScopeArg || filterMe || assigneeArg);
    if (!hasScope && !allScopeFlag) {
      console.error('Error: `search` requires a scope — text search across the entire workspace is expensive.');
      console.error('');
      console.error('Pick one of:');
      console.error('  --list <id>      scope to a single list (fastest)');
      console.error('  --folder <id>    scope to a folder');
      console.error('  --me             tasks assigned to you');
      console.error('  --assignee <u>   tasks assigned to a specific user');
      console.error('  --status <name>  tasks with a given status (repeatable via comma)');
      console.error('  --all            unscoped full-workspace scan (slow, use sparingly)');
      console.error('');
      console.error('Looking for a list or folder by name? Use `find-list "name"` instead.');
      process.exit(1);
    }
    try {
      const teamId = await getTeamId();
      const opts = {};
      if (listScopeArg) opts.list_ids = [listScopeArg];
      if (folderScopeArg) opts.project_ids = [folderScopeArg];
      if (statusScopeArg) opts.statuses = statusScopeArg.split(',').map(s => s.trim()).filter(Boolean);
      if (filterMe || assigneeArg) {
        const who = assigneeArg ? await findUser(teamId, assigneeArg) : null;
        opts.assigneeId = filterMe ? await getUserId() : (who?.id || who);
      }
      if (allScopeFlag) opts.all = true;

      const tasks = await searchTasks(teamId, targetInput || '', opts);
      if (jsonOutput) {
        console.log(JSON.stringify(tasks, null, 2));
      } else if (tasks.length === 0) {
        const q = targetInput ? ` matching "${targetInput}"` : '';
        console.log(`No tasks found${q}`);
      } else {
        console.log(formatTaskList(tasks));
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  if (command === 'find-list') {
    if (!targetInput) {
      console.error('Error: find-list requires a name query');
      console.error('Usage: node query.mjs find-list "partial name"');
      process.exit(1);
    }
    try {
      const teamId = await getTeamId();
      const { lists, folders } = await findListByName(teamId, targetInput);
      if (jsonOutput) {
        console.log(JSON.stringify({ lists, folders }, null, 2));
      } else if (!lists.length && !folders.length) {
        console.log(`No lists or folders matching "${targetInput}"`);
      } else {
        if (lists.length) {
          console.log(`Lists (${lists.length}):`);
          for (const l of lists) {
            const loc = l.folder ? `${l.space.name} / ${l.folder.name}` : `${l.space.name} (folderless)`;
            console.log(`  ${l.name}`);
            console.log(`    id: ${l.id} — ${loc}`);
          }
        }
        if (folders.length) {
          if (lists.length) console.log('');
          console.log(`Folders (${folders.length}):`);
          for (const f of folders) {
            console.log(`  ${f.name}`);
            console.log(`    id: ${f.id} — ${f.space.name} — ${f.listCount} list(s)`);
            for (const l of f.lists) {
              console.log(`      • ${l.name} (list id: ${l.id})`);
            }
          }
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
      const result = await searchDocs(workspaceId, options);
      const docs = result.docs || [];
      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
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
      console.error('Usage: node query.mjs create-doc "Doc Title" [--space <space_id>] [--content "content"]');
      process.exit(1);
    }
    try {
      const workspaceId = await getTeamId();
      const options = {};
      if (contentArg) {
        options.content = contentArg;
      }
      if (spaceArg) {
        const spaceId = parseSpaceId(spaceArg);
        options.parent = { id: spaceId, type: 4 };
      }
      const doc = await createDoc(workspaceId, targetInput, options);
      if (jsonOutput) {
        console.log(JSON.stringify(doc, null, 2));
      } else {
        console.log(`Doc created: ${doc.name}`);
        console.log(`ID: ${doc.id}`);
        if (spaceArg) {
          console.log(`Space: ${spaceArg}`);
        }
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

  if (command === 'lists') {
    if (!targetInput) {
      console.error('Error: Folder ID required');
      console.error('Usage: node query.mjs lists <folder_id>');
      process.exit(1);
    }
    try {
      const folderId = targetInput;
      const lists = await getLists(folderId);
      if (jsonOutput) {
        console.log(JSON.stringify(lists, null, 2));
      } else {
        if (lists.length === 0) {
          console.log('No lists found in this folder.');
        } else {
          for (const l of lists) {
            console.log(`  ${l.name} (ID: ${l.id})`);
          }
          console.log(`\nTotal: ${lists.length} list(s)`);
        }
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  if (command === 'space-lists') {
    if (!targetInput) {
      console.error('Error: Space ID required');
      console.error('Usage: node query.mjs space-lists <space_id>');
      process.exit(1);
    }
    try {
      const spaceId = parseSpaceId(targetInput);
      const lists = await getFolderlessLists(spaceId);
      if (jsonOutput) {
        console.log(JSON.stringify(lists, null, 2));
      } else {
        if (lists.length === 0) {
          console.log('No folderless lists found in this space.');
        } else {
          for (const l of lists) {
            console.log(`  ${l.name} (ID: ${l.id})`);
          }
          console.log(`\nTotal: ${lists.length} list(s)`);
        }
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  // Batch create from JSON file
  if (command === 'batch-create') {
    if (!fileArg && !contentArg) {
      console.error('Error: --file or --content required with a JSON plan');
      console.error('Usage: node query.mjs batch-create --file plan.json');
      console.error('       node query.mjs batch-create --content \'{"listId":"...","tasks":[...]}\'');
      process.exit(1);
    }
    try {
      const planText = contentArg || readFileSync(resolve(fileArg), 'utf-8');
      const plan = JSON.parse(planText);
      const dryRun = args.includes('--dry-run');
      const verbose = !jsonOutput; // verbose by default unless --json
      const result = await executeBatchCreate(plan, { verbose, dryRun });
      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n${result.message}`);
        if (result.errors.length > 0) {
          console.log('\nErrors:');
          for (const e of result.errors) {
            console.log(`  ${e.ref || e.name || '?'}: ${e.error}`);
          }
        }
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  // Watcher commands that don't require a target
  if (command === 'watchers') {
    const entries = getWatcherEntries();
    if (entries.length === 0) {
      console.log('No active watchers. Use watch-task, watch-list, or watch-space to create one.');
    } else if (jsonOutput) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log(`Active watchers (${entries.length}):\n`);
      for (const e of entries) {
        console.log(`  ${e.webhookId} | ${e.scope}:${e.scopeId} | ${e.events.length} events | ${e.createdAt}`);
      }
    }
    return;
  }

  if (command === 'webhooks') {
    try {
      const webhooks = await listWebhooks();
      if (webhooks.length === 0) {
        console.log('No webhooks registered in workspace.');
      } else if (jsonOutput) {
        console.log(JSON.stringify(webhooks, null, 2));
      } else {
        console.log(`Webhooks in workspace (${webhooks.length}):\n`);
        for (const wh of webhooks) {
          const health = wh.health?.status || '?';
          const fails = wh.health?.fail_count || 0;
          const scope = wh.task_id ? `task:${wh.task_id}` :
                        wh.list_id ? `list:${wh.list_id}` :
                        wh.folder_id ? `folder:${wh.folder_id}` :
                        wh.space_id ? `space:${wh.space_id}` : 'workspace';
          console.log(`  ${wh.id} | ${scope} | ${wh.events?.length || 0} events | ${health} (${fails} fails)`);
          console.log(`    → ${wh.endpoint}`);
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
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (ids.length === 1) {
          const task = await getTask(ids[0], includeSubtasks);
          if (jsonOutput) {
            console.log(JSON.stringify(task, null, 2));
          } else {
            console.log(formatTask(task));
          }
        } else {
          const results = await bulkExecute(ids, id => getTask(id, includeSubtasks));
          if (jsonOutput) {
            console.log(JSON.stringify(results.succeeded.map(s => s.result), null, 2));
          } else {
            for (const s of results.succeeded) {
              console.log(formatTask(s.result));
              console.log('');
            }
            if (results.failed.length > 0) {
              console.log(formatBulkResults({ ...results, succeeded: [] }));
            }
          }
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

        // If --threads flag, auto-expand all threads with replies
        let threadMap = {};
        if (threadsFlag) {
          const threaded = comments.filter(c => parseInt(c.reply_count, 10) > 0);
          if (threaded.length > 0) {
            const threadResults = await Promise.all(
              threaded.map(c => getThreadedComments(c.id).then(replies => [c.id, replies]))
            );
            for (const [id, replies] of threadResults) {
              threadMap[id] = replies;
            }
          }
        }

        if (jsonOutput) {
          if (threadsFlag) {
            // Embed replies into each comment for JSON output
            const enriched = comments.map(c => ({
              ...c,
              replies: threadMap[c.id] || [],
            }));
            console.log(JSON.stringify(enriched, null, 2));
          } else {
            console.log(JSON.stringify(comments, null, 2));
          }
        } else {
          console.log(formatComments(comments, threadMap));
        }
        break;
      }

      case 'thread': {
        const commentId = targetInput;
        if (!commentId) {
          console.error('Error: Comment ID required');
          console.error('Usage: node query.mjs thread <comment_id>');
          process.exit(1);
        }
        const replies = await getThreadedComments(commentId);
        if (jsonOutput) {
          console.log(JSON.stringify(replies, null, 2));
        } else {
          console.log(formatThread(null, replies));
        }
        break;
      }

      case 'reply': {
        const commentId = targetInput;
        if (!commentId) {
          console.error('Error: Comment ID required');
          console.error('Usage: node query.mjs reply <comment_id> "reply text"');
          process.exit(1);
        }
        if (!commentText) {
          console.error('Error: Reply text required');
          console.error('Usage: node query.mjs reply <comment_id> "reply text"');
          process.exit(1);
        }
        const result = await replyToComment(commentId, commentText);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Reply posted successfully (ID: ${result.id || 'ok'})`);
        }
        break;
      }

      case 'comment': {
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!commentText) {
          console.error('Error: Comment text required');
          console.error('Usage: node query.mjs comment <url|id[,id,...]> "Your comment" [--attach ./file.png]');
          process.exit(1);
        }
        // Resolve --attach file paths for comment attachments
        const commentAttachFiles = attachArgs.map(f => resolve(f));
        if (commentAttachFiles.length > 0) {
          for (const fp of commentAttachFiles) {
            if (!existsSync(fp)) {
              console.error(`Error: Attachment file not found: ${fp}`);
              process.exit(1);
            }
          }
        }
        if (ids.length === 1) {
          const result = await postComment(ids[0], commentText);
          if (jsonOutput) {
            const output = { comment: result };
            if (commentAttachFiles.length > 0) {
              output.attachments = await uploadAttachments(ids[0], commentAttachFiles);
            }
            console.log(JSON.stringify(output, null, 2));
          } else {
            console.log(`Comment posted successfully (ID: ${result.id})`);
            if (commentAttachFiles.length > 0) {
              const attResults = await uploadAttachments(ids[0], commentAttachFiles);
              for (const r of attResults) {
                const att = r.attachment || r;
                console.log(`  Attached: ${att.title || att.name || 'file'}`);
              }
            }
          }
        } else {
          const results = await bulkExecute(ids, async (id) => {
            const comment = await postComment(id, commentText);
            let attachments;
            if (commentAttachFiles.length > 0) {
              attachments = await uploadAttachments(id, commentAttachFiles);
            }
            return { comment, attachments };
          });
          if (jsonOutput) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log(formatBulkResults(results, { action: 'Comment posted on' }));
            if (commentAttachFiles.length > 0) {
              console.log(`  (${commentAttachFiles.length} file(s) attached to each task)`);
            }
          }
        }
        break;
      }

      case 'status': {
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!commentText) {
          // No status provided - show available statuses (single task only)
          const statuses = await getAvailableStatuses(ids[0]);
          console.log('Available statuses:');
          for (const s of statuses) {
            console.log(`  - "${s.status}" (${s.type})`);
          }
          break;
        }
        if (ids.length === 1) {
          const { task, matchedStatus } = await updateTaskStatus(ids[0], commentText);
          if (jsonOutput) {
            console.log(JSON.stringify(task, null, 2));
          } else {
            console.log(`Status updated to "${matchedStatus.status}"`);
          }
        } else {
          const results = await bulkExecute(ids, id => updateTaskStatus(id, commentText));
          if (jsonOutput) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log(formatBulkResults(results, {
              action: 'Updated',
              formatItem: s => `${s.id}: status → "${s.result.matchedStatus.status}"`,
            }));
          }
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
          listId = getActiveCredentials().defaultListId;
          if (!listId) {
            console.error('Error: No list ID provided and no defaultListId set for this account');
            console.error('Usage: node query.mjs create <list_id> "Task title" [options]');
            console.error('   Or: Set defaultListId in accounts.json to use: node query.mjs create "Task title"');
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
        // --file/--content populate contentArg; accept them here too so a long
        // description doesn't have to go through a second `description` call.
        const createDescription = descriptionArg || contentArg;
        if (createDescription) {
          // Use markdown_description for proper markdown rendering in ClickUp
          // Note: Task descriptions use markdown_description (ClickUp parses),
          // while comments use JSON array format (we parse via markdownToClickUp)
          options.markdown_description = createDescription;
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
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: User required');
          console.error('Usage: node query.mjs assign <task[,task,...]> <user>');
          process.exit(1);
        }
        const teamId = await getTeamId();
        const user = await findUser(teamId, arg2);
        if (!user) {
          console.error(`Error: User "${arg2}" not found in team`);
          process.exit(1);
        }
        if (ids.length === 1) {
          const task = await assignTask(ids[0], [user.id]);
          if (jsonOutput) {
            console.log(JSON.stringify(task, null, 2));
          } else {
            console.log(`Task assigned to ${user.username || user.email}`);
          }
        } else {
          const results = await bulkExecute(ids, id => assignTask(id, [user.id]));
          if (jsonOutput) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log(formatBulkResults(results, { action: `Assigned to ${user.username || user.email}:` }));
          }
        }
        break;
      }

      case 'due': {
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Due date required');
          console.error('Usage: node query.mjs due <task[,task,...]> "date"');
          console.error('Examples: "tomorrow", "next friday", "2024-01-15", "+3d"');
          process.exit(1);
        }
        if (ids.length === 1) {
          const task = await setDueDate(ids[0], arg2);
          if (jsonOutput) {
            console.log(JSON.stringify(task, null, 2));
          } else {
            const dueDate = task.due_date ? new Date(parseInt(task.due_date, 10)).toLocaleDateString() : 'cleared';
            console.log(`Due date set to: ${dueDate}`);
          }
        } else {
          const results = await bulkExecute(ids, id => setDueDate(id, arg2));
          if (jsonOutput) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log(formatBulkResults(results, { action: 'Due date set on' }));
          }
        }
        break;
      }

      case 'start': {
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Start date required');
          console.error('Usage: node query.mjs start <task[,task,...]> "date"');
          console.error('Examples: "today", "tomorrow", "2024-01-15", "+3d"');
          process.exit(1);
        }
        if (ids.length === 1) {
          const task = await setStartDate(ids[0], arg2);
          if (jsonOutput) {
            console.log(JSON.stringify(task, null, 2));
          } else {
            const startDate = task.start_date ? new Date(parseInt(task.start_date, 10)).toLocaleDateString() : 'cleared';
            console.log(`Start date set to: ${startDate}`);
          }
        } else {
          const results = await bulkExecute(ids, id => setStartDate(id, arg2));
          if (jsonOutput) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log(formatBulkResults(results, { action: 'Start date set on' }));
          }
        }
        break;
      }

      case 'schedule': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2 || !arg3) {
          console.error('Error: Both start and due dates required');
          console.error('Usage: node query.mjs schedule <task> "start_date" "due_date"');
          console.error('Examples: node query.mjs schedule abc123 "today" "friday"');
          process.exit(1);
        }
        const task = await setDates(taskId, { start: arg2, due: arg3 });
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          const startDate = task.start_date ? new Date(parseInt(task.start_date, 10)).toLocaleDateString() : 'not set';
          const dueDate = task.due_date ? new Date(parseInt(task.due_date, 10)).toLocaleDateString() : 'not set';
          console.log(`Scheduled: ${startDate} → ${dueDate}`);
        }
        break;
      }

      case 'rename': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: New name required');
          console.error('Usage: node query.mjs rename <task> "new name"');
          process.exit(1);
        }
        const task = await updateTask(taskId, { name: arg2 });
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`Task renamed to: ${task.name}`);
        }
        break;
      }

      case 'priority': {
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Priority level required');
          console.error('Usage: node query.mjs priority <task[,task,...]> <level>');
          console.error('Levels: urgent, high, normal, low, none');
          process.exit(1);
        }
        if (ids.length === 1) {
          const { task, priority } = await setPriority(ids[0], arg2);
          if (jsonOutput) {
            console.log(JSON.stringify(task, null, 2));
          } else {
            console.log(`Priority set to: ${priority}`);
          }
        } else {
          const results = await bulkExecute(ids, id => setPriority(id, arg2));
          if (jsonOutput) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log(formatBulkResults(results, {
              action: 'Priority set on',
              formatItem: s => `${s.id}: priority → ${s.result.priority}`,
            }));
          }
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
        const workspaceId = await getTeamId();
        const task = await moveTask(taskId, listId, workspaceId);
        if (jsonOutput) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`Task moved successfully`);
          if (task.url) console.log(`URL: ${task.url}`);
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

      case 'update-comment': {
        const commentId = targetInput;
        if (!commentId) {
          console.error('Error: Comment ID required');
          console.error('Usage: node query.mjs update-comment <comment_id> "new text"');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Comment text required');
          console.error('Usage: node query.mjs update-comment <comment_id> "new text"');
          process.exit(1);
        }
        const result = await updateComment(commentId, { comment_text: arg2 });
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Comment ${commentId} updated`);
        }
        break;
      }

      case 'resolve-comment': {
        const commentId = targetInput;
        if (!commentId) {
          console.error('Error: Comment ID required');
          console.error('Usage: node query.mjs resolve-comment <comment_id>');
          process.exit(1);
        }
        const result = await updateComment(commentId, { resolved: true });
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Comment ${commentId} resolved`);
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
        const result = await addWatcher(taskId, user.id);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Added ${user.username || user.email} as watcher`);
        }
        break;
      }

      case 'unwatch': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: User required');
          console.error('Usage: node query.mjs unwatch <task> <user>');
          process.exit(1);
        }
        const teamId = await getTeamId();
        const user = await findUser(teamId, arg2);
        if (!user) {
          console.error(`Error: User "${arg2}" not found in team`);
          process.exit(1);
        }
        const result = await removeWatcher(taskId, user.id);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Removed ${user.username || user.email} as watcher`);
        }
        break;
      }

      case 'tag': {
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Tag name required');
          console.error('Usage: node query.mjs tag <task[,task,...]> "tag_name"');
          process.exit(1);
        }
        if (ids.length === 1) {
          await addTag(ids[0], arg2);
          if (jsonOutput) {
            console.log(JSON.stringify({ tagged: true, taskId: ids[0], tag: arg2 }, null, 2));
          } else {
            console.log(`Tag "${arg2}" added to task`);
          }
        } else {
          const results = await bulkExecute(ids, id => addTag(id, arg2));
          if (jsonOutput) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log(formatBulkResults(results, { action: `Tagged "${arg2}" on` }));
          }
        }
        break;
      }

      case 'remove-tag': {
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Tag name required');
          console.error('Usage: node query.mjs remove-tag <task[,task,...]> "tag_name"');
          process.exit(1);
        }
        if (ids.length === 1) {
          await removeTag(ids[0], arg2);
          if (jsonOutput) {
            console.log(JSON.stringify({ removed: true, taskId: ids[0], tag: arg2 }, null, 2));
          } else {
            console.log(`Tag "${arg2}" removed from task`);
          }
        } else {
          const results = await bulkExecute(ids, id => removeTag(id, arg2));
          if (jsonOutput) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log(formatBulkResults(results, { action: `Removed tag "${arg2}" from` }));
          }
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

      case 'depends': {
        // Set task as waiting on another task
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Other task ID required');
          console.error('Usage: node query.mjs depends <task> <waits_on_task>');
          console.error('This sets the first task as waiting on/blocked by the second task.');
          process.exit(1);
        }
        const dependsOnId = parseTaskId(arg2);
        if (!dependsOnId) {
          console.error('Error: Could not parse dependency task ID');
          process.exit(1);
        }
        const result = await addDependency(taskId, { depends_on: dependsOnId });
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Task ${taskId} now waits on task ${dependsOnId}`);
        }
        break;
      }

      case 'blocks': {
        // Set task as blocking another task
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Other task ID required');
          console.error('Usage: node query.mjs blocks <task> <blocked_task>');
          console.error('This sets the first task as blocking the second task.');
          process.exit(1);
        }
        const blocksId = parseTaskId(arg2);
        if (!blocksId) {
          console.error('Error: Could not parse blocked task ID');
          process.exit(1);
        }
        const result = await addDependency(taskId, { dependency_of: blocksId });
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Task ${taskId} now blocks task ${blocksId}`);
        }
        break;
      }

      case 'task-link': {
        // Create bidirectional link between tasks
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: Other task ID required');
          console.error('Usage: node query.mjs task-link <task> <other_task>');
          console.error('This creates a bidirectional link between tasks.');
          process.exit(1);
        }
        const linksToId = parseTaskId(arg2);
        if (!linksToId) {
          console.error('Error: Could not parse target task ID');
          process.exit(1);
        }
        const result = await addTaskLink(taskId, linksToId);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Tasks ${taskId} and ${linksToId} are now linked`);
        }
        break;
      }

      case 'archive': {
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (ids.length === 1) {
          const task = await archiveTask(ids[0]);
          if (jsonOutput) {
            console.log(JSON.stringify(task, null, 2));
          } else {
            console.log(`Task archived: ${task.name || ids[0]}`);
            if (task.url) console.log(`URL: ${task.url}`);
          }
        } else {
          const results = await bulkExecute(ids, id => archiveTask(id));
          if (jsonOutput) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log(formatBulkResults(results, { action: 'Archived' }));
          }
        }
        break;
      }

      case 'unarchive': {
        const ids = splitIds(targetInput).map(parseTaskId).filter(Boolean);
        if (ids.length === 0) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        if (ids.length === 1) {
          const task = await unarchiveTask(ids[0]);
          if (jsonOutput) {
            console.log(JSON.stringify(task, null, 2));
          } else {
            console.log(`Task restored: ${task.name || ids[0]}`);
            if (task.url) console.log(`URL: ${task.url}`);
          }
        } else {
          const results = await bulkExecute(ids, id => unarchiveTask(id));
          if (jsonOutput) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.log(formatBulkResults(results, { action: 'Restored' }));
          }
        }
        break;
      }

      case 'claim': {
        const sessionId = detectClaudeSessionId();
        if (!sessionId) {
          console.error('Error: Could not determine Claude Code session ID.');
          console.error('Tried: $CLAUDE_SESSION_ID, then most-recently-modified');
          console.error('       ~/.claude/projects/*/*.jsonl (within 60s).');
          console.error('Set CLAUDE_SESSION_ID explicitly if running outside a live session.');
          process.exit(1);
        }
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Could not parse task ID from input');
          process.exit(1);
        }
        const field = await findCustomFieldByName(taskId, 'session');
        if (!field) {
          console.error('Error: No "Session ID" custom field found on this task.');
          console.error('Add a text custom field named "Session ID" to the task\'s list in ClickUp.');
          process.exit(1);
        }
        await setCustomField(taskId, field.id, sessionId);
        if (jsonOutput) {
          console.log(JSON.stringify({ taskId, fieldId: field.id, fieldName: field.name, sessionId }, null, 2));
        } else {
          console.log(`Session linked to task ${taskId}`);
          console.log(`Field: ${field.name}`);
          console.log(`Session: ${sessionId}`);
        }
        break;
      }

      // List commands
      case 'list': {
        const listId = parseListId(targetInput);
        if (!listId) {
          console.error('Error: Could not parse list ID from input');
          process.exit(1);
        }
        const list = await getList(listId);
        if (jsonOutput) {
          console.log(JSON.stringify(list, null, 2));
        } else {
          console.log(formatList(list));
        }
        break;
      }

      case 'create-list': {
        const spaceId = parseSpaceId(targetInput);
        if (!spaceId) {
          console.error('Error: Could not parse space ID from input');
          console.error('Usage: node query.mjs create-list <space_id|space_url> "List Name"');
          process.exit(1);
        }
        if (!arg2) {
          console.error('Error: List name required');
          console.error('Usage: node query.mjs create-list <space_id|space_url> "List Name"');
          process.exit(1);
        }
        const options = {};
        if (contentArg) {
          options.content = contentArg;
        }
        const list = await createList(spaceId, arg2, options);
        if (jsonOutput) {
          console.log(JSON.stringify(list, null, 2));
        } else {
          console.log(`List created: ${list.name}`);
          console.log(`ID: ${list.id}`);
        }
        break;
      }

      case 'update-list': {
        const listId = parseListId(targetInput);
        if (!listId) {
          console.error('Error: Could not parse list ID from input');
          console.error('Usage: node query.mjs update-list <list_id> --name "new name" --content "description"');
          process.exit(1);
        }
        if (!nameArg && !contentArg) {
          console.error('Error: At least --name or --content is required');
          console.error('Usage: node query.mjs update-list <list_id> --name "new name" --content "description"');
          process.exit(1);
        }
        const updates = {};
        if (nameArg) {
          updates.name = nameArg;
        }
        if (contentArg) {
          updates.content = contentArg;
        }
        const list = await updateList(listId, updates);
        if (jsonOutput) {
          console.log(JSON.stringify(list, null, 2));
        } else {
          console.log(`List updated: ${list.name || listId}`);
          if (list.id) console.log(`ID: ${list.id}`);
        }
        break;
      }

      case 'delete-list': {
        const listId = parseListId(targetInput);
        if (!listId) {
          console.error('Error: Could not parse list ID from input');
          console.error('Usage: node query.mjs delete-list <list_id>');
          process.exit(1);
        }
        await deleteList(listId);
        if (jsonOutput) {
          console.log(JSON.stringify({ deleted: true, listId }, null, 2));
        } else {
          console.log(`List ${listId} deleted`);
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
        if (parentArg) {
          options.parentPageId = parentArg;
        }
        const page = await createPage(workspaceId, docId, arg2, options);
        if (jsonOutput) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          console.log(`Page created: ${page.name}`);
          console.log(`ID: ${page.id}`);
          if (parentArg) {
            console.log(`Parent: ${parentArg}`);
          }
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
        if (!contentArg && !nameArg && !archiveFlag) {
          console.error('Error: At least --content, --name, or --archive is required');
          console.error('Usage: node query.mjs edit-page <doc_id> <page_id> [--content "content"] [--name "name"] [--archive]');
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
        if (archiveFlag) {
          updates.archived = true;
        }
        const page = await editPage(workspaceId, docId, pageId, updates);
        if (jsonOutput) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          if (archiveFlag) {
            console.log('Page archived successfully');
          } else {
            console.log('Page updated successfully');
          }
          if (page.id) {
            console.log(`ID: ${page.id}`);
          }
        }
        break;
      }

      case 'attach': {
        const taskId = parseTaskId(targetInput);
        if (!taskId) {
          console.error('Error: Task ID or URL required');
          console.error('Usage: node query.mjs attach <url|id> --attach ./file1.png --attach ./file2.pdf');
          console.error('');
          console.error('You can also use --file for a single file:');
          console.error('  node query.mjs attach <url|id> --file ./screenshot.png');
          process.exit(1);
        }
        // Collect files from --attach args and --file arg
        const filesToUpload = [...attachArgs.map(f => resolve(f))];
        if (fileArg && !filesToUpload.includes(resolve(fileArg))) {
          filesToUpload.push(resolve(fileArg));
        }
        if (filesToUpload.length === 0) {
          console.error('Error: At least one file required');
          console.error('Usage: node query.mjs attach <url|id> --attach ./file1.png [--attach ./file2.pdf]');
          process.exit(1);
        }
        // Validate all files exist before uploading
        for (const fp of filesToUpload) {
          if (!existsSync(fp)) {
            console.error(`Error: File not found: ${fp}`);
            process.exit(1);
          }
        }
        const attachResults = await uploadAttachments(taskId, filesToUpload);
        if (jsonOutput) {
          console.log(JSON.stringify(attachResults, null, 2));
        } else {
          for (const result of attachResults) {
            const att = result.attachment || result;
            const title = att.title || att.name || 'file';
            const url = att.url || att.url_w_query || '';
            console.log(`Attached: ${title}${url ? ` (${url})` : ''}`);
          }
          console.log(`\n${filesToUpload.length} file(s) attached to task ${taskId}`);
        }
        break;
      }

      case 'fetch-image':
      case 'fetch-attachment': {
        const url = targetInput;
        if (!url) {
          console.error('Error: Attachment URL required');
          console.error('Usage: node query.mjs fetch-image <url> [--output path]');
          console.error('');
          console.error('Downloads a ClickUp attachment to a local temp file.');
          console.error('The URL is shown in comment output as [Attachment: name](url)');
          process.exit(1);
        }

        // Determine output path
        const outputFlag = args.indexOf('--output');
        let outputPath;
        if (outputFlag !== -1 && args[outputFlag + 1]) {
          outputPath = resolve(args[outputFlag + 1]);
        } else {
          // Extract filename from URL or use a default
          const urlPath = new URL(url).pathname;
          const filename = urlPath.split('/').pop() || 'attachment';
          const clickupTmp = join(tmpdir(), 'clickup-attachments');
          mkdirSync(clickupTmp, { recursive: true });
          outputPath = join(clickupTmp, filename);
        }

        // Fetch the attachment
        const creds = getActiveCredentials();
        const resp = await fetch(url, {
          headers: { Authorization: creds.apiToken },
        });
        if (!resp.ok) {
          // Retry without auth (CDN URLs may not need it)
          const resp2 = await fetch(url);
          if (!resp2.ok) {
            console.error(`Error: Failed to fetch attachment (${resp2.status})`);
            process.exit(1);
          }
          const buffer = Buffer.from(await resp2.arrayBuffer());
          writeFileSync(outputPath, buffer);
        } else {
          const buffer = Buffer.from(await resp.arrayBuffer());
          writeFileSync(outputPath, buffer);
        }

        if (jsonOutput) {
          console.log(JSON.stringify({ path: outputPath, url }, null, 2));
        } else {
          console.log(`Downloaded: ${outputPath}`);
        }
        break;
      }

      // ── Webhook Watcher Commands ──────────────────────────────────────────

      case 'watch-task': {
        // watch-task <task_id>[,task_id2,...] [--events evt1,evt2]
        if (!targetInput) {
          console.error('Error: Task ID(s) required');
          console.error('Usage: node query.mjs watch-task <task_id>[,id2,...] [--events evt1,evt2]');
          process.exit(1);
        }
        const webhookUrlPath = join(resolve(import.meta.dirname), 'webhook-url.txt');
        let webhookUrl;
        if (existsSync(webhookUrlPath)) {
          webhookUrl = readFileSync(webhookUrlPath, 'utf-8').trim();
        } else {
          // Read from accounts.json
          const accountsPath = join(resolve(import.meta.dirname), 'accounts.json');
          const accts = JSON.parse(readFileSync(accountsPath, 'utf-8'));
          if (!accts.webhookSiteToken) {
            console.error('Error: No webhook.site token configured.');
            console.error('Add "webhookSiteToken" to accounts.json.');
            process.exit(1);
          }
          webhookUrl = `https://webhook.site/${accts.webhookSiteToken}`;
        }
        const events = eventsArg ? eventsArg.split(',') : DEFAULT_TASK_EVENTS;
        const taskIds = targetInput.split(',').map(id => parseTaskId(id));
        const results = [];

        for (const taskId of taskIds) {
          const wh = await createWebhook(webhookUrl, events, { taskId });
          const entry = {
            webhookId: wh.id,
            secret: wh.secret,
            scope: 'task',
            scopeId: taskId,
            events,
            endpoint: webhookUrl,
            createdAt: new Date().toISOString(),
          };
          addWatcherEntry(entry);
          results.push(entry);
        }

        if (jsonOutput) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          for (const r of results) {
            console.log(`Watching task ${r.scopeId} (webhook: ${r.webhookId})`);
            console.log(`  Events: ${r.events.join(', ')}`);
          }
          console.log(`\nStart listener: node query.mjs listen`);
        }
        break;
      }

      case 'watch-list': {
        if (!targetInput) {
          console.error('Error: List ID required');
          console.error('Usage: node query.mjs watch-list <list_id> [--events evt1,evt2]');
          process.exit(1);
        }
        const webhookUrlPath = join(resolve(import.meta.dirname), 'webhook-url.txt');
        let webhookUrl;
        if (existsSync(webhookUrlPath)) {
          webhookUrl = readFileSync(webhookUrlPath, 'utf-8').trim();
        } else {
          const accountsPath = join(resolve(import.meta.dirname), 'accounts.json');
          const accts = JSON.parse(readFileSync(accountsPath, 'utf-8'));
          if (!accts.webhookSiteToken) {
            console.error('Error: No webhook.site token configured.');
            process.exit(1);
          }
          webhookUrl = `https://webhook.site/${accts.webhookSiteToken}`;
        }
        const listId = parseListId(targetInput);
        const events = eventsArg ? eventsArg.split(',') : DEFAULT_LIST_EVENTS;
        const wh = await createWebhook(webhookUrl, events, { listId });
        const entry = {
          webhookId: wh.id,
          secret: wh.secret,
          scope: 'list',
          scopeId: listId,
          events,
          endpoint: webhookUrl,
          createdAt: new Date().toISOString(),
        };
        addWatcherEntry(entry);

        if (jsonOutput) {
          console.log(JSON.stringify(entry, null, 2));
        } else {
          console.log(`Watching list ${listId} (webhook: ${wh.id})`);
          console.log(`  Events: ${events.join(', ')}`);
          console.log(`\nStart listener: node query.mjs listen`);
        }
        break;
      }

      case 'watch-space': {
        if (!targetInput) {
          console.error('Error: Space ID required');
          console.error('Usage: node query.mjs watch-space <space_id> [--events evt1,evt2]');
          process.exit(1);
        }
        const webhookUrlPath = join(resolve(import.meta.dirname), 'webhook-url.txt');
        let webhookUrl;
        if (existsSync(webhookUrlPath)) {
          webhookUrl = readFileSync(webhookUrlPath, 'utf-8').trim();
        } else {
          const accountsPath = join(resolve(import.meta.dirname), 'accounts.json');
          const accts = JSON.parse(readFileSync(accountsPath, 'utf-8'));
          if (!accts.webhookSiteToken) {
            console.error('Error: No webhook.site token configured.');
            process.exit(1);
          }
          webhookUrl = `https://webhook.site/${accts.webhookSiteToken}`;
        }
        const spaceId = parseSpaceId(targetInput);
        const events = eventsArg ? eventsArg.split(',') : DEFAULT_SPACE_EVENTS;
        const wh = await createWebhook(webhookUrl, events, { spaceId });
        const entry = {
          webhookId: wh.id,
          secret: wh.secret,
          scope: 'space',
          scopeId: spaceId,
          events,
          endpoint: webhookUrl,
          createdAt: new Date().toISOString(),
        };
        addWatcherEntry(entry);

        if (jsonOutput) {
          console.log(JSON.stringify(entry, null, 2));
        } else {
          console.log(`Watching space ${spaceId} (webhook: ${wh.id})`);
          console.log(`  Events: ${events.join(', ')}`);
          console.log(`\nStart listener: node query.mjs listen`);
        }
        break;
      }

      case 'unwatch-webhook': {
        if (!targetInput) {
          console.error('Error: Webhook ID required (or --all to remove all)');
          console.error('Usage: node query.mjs unwatch-webhook <webhook_id>');
          console.error('       node query.mjs unwatch-webhook --all');
          process.exit(1);
        }
        if (targetInput === '--all') {
          const entries = getWatcherEntries();
          if (entries.length === 0) {
            console.log('No watchers to remove.');
            break;
          }
          let removed = 0;
          for (const e of entries) {
            try {
              await deleteWebhook(e.webhookId);
              removed++;
            } catch (err) {
              console.error(`  Failed to delete ${e.webhookId}: ${err.message}`);
            }
          }
          clearAllWatcherEntries();
          console.log(`Removed ${removed}/${entries.length} webhook(s).`);
        } else {
          await deleteWebhook(targetInput);
          removeWatcherEntry(targetInput);
          console.log(`Webhook ${targetInput} deleted.`);
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

main().then(() => {
  // --cleanup: delete the source file after successful execution
  if (cleanupFlag && fileArg) {
    const filePath = resolve(fileArg);
    try {
      unlinkSync(filePath);
    } catch {
      // Silently ignore cleanup failures
    }
  }
});
