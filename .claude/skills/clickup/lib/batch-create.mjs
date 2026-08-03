/**
 * Batch Task Creator — create an entire project from a JSON plan
 *
 * Reads a JSON file with a tasks array, creates them in order,
 * resolves inter-task dependencies using temporary IDs (ref keys),
 * and sets up assignees, priorities, statuses, and subtasks.
 *
 * JSON Schema:
 * {
 *   "listId": "901111220963",       // default list (can override per task)
 *   "tasks": [
 *     {
 *       "ref": "design",            // local ref for dependencies (optional)
 *       "name": "Design system architecture",
 *       "description": "Create the architecture doc",
 *       "assignee": "justin",       // name, email, or ID
 *       "priority": "high",         // urgent/high/normal/low/none
 *       "status": "to do",          // status name
 *       "dueDate": "+7d",           // relative or absolute date
 *       "startDate": "today",
 *       "tags": ["architecture"],
 *       "listId": "901111220964",   // override default list
 *       "dependsOn": ["other-ref"], // must complete before this task starts
 *       "blocks": ["other-ref"],    // this task blocks other tasks
 *       "subtasks": [
 *         { "name": "Draft ERD", "assignee": "mark" },
 *         { "name": "Review ERD", "assignee": "dakota" }
 *       ]
 *     }
 *   ]
 * }
 */

import { createTask, createSubtask, addDependency, setPriority, parseDateInput, setDueDate, setStartDate, assignTask, addTag } from '../api/tasks.mjs';
import { findUser } from '../api/user.mjs';

/**
 * Execute a batch create plan.
 * @param {object} plan - Parsed JSON plan
 * @param {object} opts - { verbose, dryRun }
 * @returns {object} Results with created tasks and any errors
 */
export async function executeBatchCreate(plan, opts = {}) {
  const { verbose = false, dryRun = false } = opts;
  const defaultListId = plan.listId;
  const tasks = plan.tasks || [];

  if (tasks.length === 0) {
    return { created: [], errors: [], message: 'No tasks in plan' };
  }

  // Phase 1: Create all tasks and map refs to real IDs
  const refToId = {};
  const created = [];
  const errors = [];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const listId = t.listId || defaultListId;

    if (!listId) {
      errors.push({ ref: t.ref || i, error: 'No listId specified (and no default)' });
      continue;
    }

    if (dryRun) {
      const fakeId = `dry-run-${i}`;
      if (t.ref) refToId[t.ref] = fakeId;
      created.push({ ref: t.ref, id: fakeId, name: t.name, dryRun: true });
      if (verbose) process.stderr.write(`[dry-run] Would create: "${t.name}" in list ${listId}\n`);
      continue;
    }

    try {
      // Build create options
      const createOpts = {};
      if (t.description) createOpts.markdown_description = t.description;
      if (t.status) createOpts.status = t.status;
      if (t.dueDate) {
        try {
          const date = parseDateInput(t.dueDate);
          if (date) createOpts.due_date = date instanceof Date ? date.getTime() : date;
        } catch (e) {
          if (verbose) process.stderr.write(`  Warning: Could not parse due date "${t.dueDate}": ${e.message}\n`);
        }
      }
      if (t.startDate) {
        try {
          const date = parseDateInput(t.startDate);
          if (date) createOpts.start_date = date instanceof Date ? date.getTime() : date;
        } catch (e) {
          if (verbose) process.stderr.write(`  Warning: Could not parse start date "${t.startDate}": ${e.message}\n`);
        }
      }

      const result = await createTask(listId, t.name, createOpts);
      const taskId = result.id;

      if (t.ref) refToId[t.ref] = taskId;
      created.push({ ref: t.ref || null, id: taskId, name: t.name });

      if (verbose) process.stderr.write(`[${i + 1}/${tasks.length}] Created "${t.name}" → ${taskId}\n`);

      // Set priority
      if (t.priority) {
        await setPriority(taskId, t.priority);
      }

      // Assign
      if (t.assignee) {
        try {
          const user = await findUser(t.assignee);
          if (user) await assignTask(taskId, user.id);
        } catch (e) {
          if (verbose) process.stderr.write(`  Warning: Could not assign "${t.assignee}": ${e.message}\n`);
        }
      }

      // Tags
      if (t.tags && t.tags.length > 0) {
        for (const tag of t.tags) {
          try {
            await addTag(taskId, tag);
          } catch (e) {
            if (verbose) process.stderr.write(`  Warning: Could not add tag "${tag}": ${e.message}\n`);
          }
        }
      }

      // Subtasks
      if (t.subtasks && t.subtasks.length > 0) {
        for (const sub of t.subtasks) {
          try {
            const subResult = await createSubtask(taskId, sub.name, {
              description: sub.description || undefined,
              status: sub.status || undefined,
            });
            if (verbose) process.stderr.write(`  ↳ Subtask "${sub.name}" → ${subResult.id}\n`);

            // Assign subtask
            if (sub.assignee) {
              try {
                const user = await findUser(sub.assignee);
                if (user) await assignTask(subResult.id, user.id);
              } catch {}
            }
          } catch (e) {
            errors.push({ ref: t.ref, subtask: sub.name, error: e.message });
          }
        }
      }
    } catch (e) {
      errors.push({ ref: t.ref || i, name: t.name, error: e.message });
      if (verbose) process.stderr.write(`  Error creating "${t.name}": ${e.message}\n`);
    }
  }

  // Phase 2: Wire up dependencies (now that all tasks exist)
  if (!dryRun) {
    for (const t of tasks) {
      if (!t.ref || !refToId[t.ref]) continue;
      const taskId = refToId[t.ref];

      // dependsOn: this task depends on (waits for) the referenced tasks
      if (t.dependsOn && t.dependsOn.length > 0) {
        for (const depRef of t.dependsOn) {
          const depId = refToId[depRef];
          if (!depId) {
            errors.push({ ref: t.ref, error: `Dependency ref "${depRef}" not found` });
            continue;
          }
          try {
            await addDependency(taskId, { depends_on: depId });
            if (verbose) process.stderr.write(`  ${t.ref} depends on ${depRef}\n`);
          } catch (e) {
            errors.push({ ref: t.ref, dependency: depRef, error: e.message });
          }
        }
      }

      // blocks: this task blocks the referenced tasks
      if (t.blocks && t.blocks.length > 0) {
        for (const blockRef of t.blocks) {
          const blockId = refToId[blockRef];
          if (!blockId) {
            errors.push({ ref: t.ref, error: `Block ref "${blockRef}" not found` });
            continue;
          }
          try {
            await addDependency(taskId, { dependency_of: blockId });
            if (verbose) process.stderr.write(`  ${t.ref} blocks ${blockRef}\n`);
          } catch (e) {
            errors.push({ ref: t.ref, blocks: blockRef, error: e.message });
          }
        }
      }
    }
  }

  return {
    created,
    errors,
    refMap: refToId,
    message: `Created ${created.length}/${tasks.length} task(s)${errors.length > 0 ? `, ${errors.length} error(s)` : ''}`,
  };
}
