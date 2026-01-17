/**
 * Turn Engine for Ralph Daemon
 *
 * Implements controlled turn-by-turn execution with:
 * - Command queue for pause/resume/inject/abort
 * - Checkpoint after each turn
 * - Guidance injection into prompts
 * - Lease tokens for multi-agent coordination
 * - Risk detection for sensitive operations
 */

import { EventEmitter } from 'events';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { getStorage, PrdStorage } from './storage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ralphDir = resolve(__dirname, '..');
const promptsDir = resolve(ralphDir, 'prompts');

// Session states
export const SessionState = {
  CREATED: 'CREATED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  WAITING: 'WAITING',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  ABORTED: 'ABORTED',
  COMPLETED: 'COMPLETED',
};

// Health states
export const HealthState = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  STUCK: 'STUCK',
  CRITICAL: 'CRITICAL',
};

// Command types
export const CommandType = {
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  INJECT: 'INJECT',
  ABORT: 'ABORT',
  SKIP: 'SKIP',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
};

// Guidance types (typed envelopes as per Gemini recommendation)
export const GuidanceType = {
  CORRECTION: 'CORRECTION',
  HINT: 'HINT',
  NEW_REQUIREMENT: 'NEW_REQUIREMENT',
  ENVIRONMENT_UPDATE: 'ENVIRONMENT_UPDATE',
};

// Sensitive tools that require approval (human-in-the-loop gate)
const SENSITIVE_TOOLS = [
  'git push',
  'rm -rf',
  'DELETE FROM',
  'DROP TABLE',
];

/**
 * Turn Engine - Manages controlled execution of a single session
 */
export class TurnEngine extends EventEmitter {
  constructor(sessionId, options = {}) {
    super();
    this.sessionId = sessionId;
    this.storage = getStorage();
    this.session = null;
    this.prdStorage = null;

    // Execution state
    this.isRunning = false;
    this.currentTurn = 0;
    this.currentStory = null;
    this.agentClient = null;

    // Command queue (in-memory for fast access, backed by SQLite)
    this.pendingGuidance = [];

    // Options
    this.options = {
      model: options.model || 'opus',
      maxTurns: options.maxTurns || 100,
      sensitiveToolsEnabled: options.sensitiveToolsEnabled ?? true,
      checkpointInterval: options.checkpointInterval || 10,
      ...options,
    };
  }

  /**
   * Initialize the engine with session data
   */
  async initialize() {
    this.session = this.storage.getSession(this.sessionId);
    if (!this.session) {
      throw new Error(`Session ${this.sessionId} not found`);
    }

    this.prdStorage = new PrdStorage(this.session.prdPath);
    if (!this.prdStorage.exists()) {
      throw new Error(`PRD not found at ${this.session.prdPath}`);
    }

    // Initialize progress log
    this.prdStorage.initProgressLog();

    // Update stories count
    const prd = this.prdStorage.read();
    this.storage.updateSession(this.sessionId, {
      storiesTotal: prd.userStories.length,
      storiesCompleted: prd.userStories.filter(s => s.passes).length,
    });

    this.log('info', 'Turn engine initialized');
    return this;
  }

  /**
   * Start execution
   */
  async start() {
    if (this.isRunning) {
      throw new Error('Engine is already running');
    }

    this.isRunning = true;
    this.storage.updateSession(this.sessionId, {
      status: SessionState.RUNNING,
      startedAt: new Date().toISOString(),
    });

    this.log('info', 'Starting execution');
    this.emit('started', { sessionId: this.sessionId });

    try {
      await this.runLoop();
    } catch (error) {
      this.log('error', `Execution error: ${error.message}`);
      this.emit('error', { sessionId: this.sessionId, error });
      throw error;
    }
  }

  /**
   * Main execution loop - processes stories one at a time
   */
  async runLoop() {
    while (this.isRunning) {
      // Check for pending commands
      await this.processCommands();

      // If paused or waiting, block
      const session = this.storage.getSession(this.sessionId);
      if (session.status === SessionState.PAUSED || session.status === SessionState.WAITING) {
        await this.waitForResume();
        continue;
      }

      if (session.status === SessionState.ABORTED) {
        this.log('info', 'Session aborted');
        break;
      }

      // Get next story
      this.currentStory = this.prdStorage.getNextStory();
      if (!this.currentStory) {
        // All stories complete
        this.storage.updateSession(this.sessionId, {
          status: SessionState.COMPLETED,
          completedAt: new Date().toISOString(),
        });
        this.log('info', 'All stories complete!');
        this.emit('completed', { sessionId: this.sessionId });
        break;
      }

      // Update current story in session and reset per-story turn counter
      this.storage.updateSession(this.sessionId, {
        currentStoryId: this.currentStory.id,
        currentStoryTitle: this.currentStory.title,
        storyTurnCount: 0,
      });

      // Log iteration banner
      const progress = this.prdStorage.getProgress();
      const storyNum = progress.completed + 1;
      this.log('story', `═══ Story ${storyNum}/${progress.total}: ${this.currentStory.id} - ${this.currentStory.title} ═══`);
      this.emit('storyStarted', { sessionId: this.sessionId, story: this.currentStory });

      // Run the story iteration
      try {
        const result = await this.runStoryIteration();

        if (result.allComplete) {
          this.storage.updateSession(this.sessionId, {
            status: SessionState.COMPLETED,
            completedAt: new Date().toISOString(),
          });
          this.emit('completed', { sessionId: this.sessionId });
          break;
        }

        // Re-read PRD to check if story was marked complete
        const prd = this.prdStorage.read();
        const updatedStory = prd.userStories.find(s => s.id === this.currentStory.id);
        if (updatedStory?.passes) {
          this.log('info', `Story ${this.currentStory.id} completed`);
          this.emit('storyCompleted', { sessionId: this.sessionId, story: this.currentStory });

          // Update session counts
          this.storage.updateSession(this.sessionId, {
            storiesCompleted: prd.userStories.filter(s => s.passes).length,
          });
        }
      } catch (error) {
        this.log('error', `Story iteration error: ${error.message}`);
        this.updateHealth(HealthState.DEGRADED, error.message);
      }

      // Brief pause between stories
      await this.sleep(2000);
    }

    this.isRunning = false;
  }

  /**
   * Run a single story iteration using Claude Agent SDK
   */
  async runStoryIteration() {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    // Build prompt
    const prompt = this.buildPrompt();

    // Reset turn count for this iteration
    this.currentTurn = 0;
    let warned70 = false;
    let warned90 = false;

    // Track response
    let fullResponse = '';
    const startTime = Date.now();

    // Change to working directory
    const originalCwd = process.cwd();
    if (this.session.workingDirectory) {
      process.chdir(this.session.workingDirectory);
    }

    try {
      // Create turn-tracking hook
      const turnHook = async (toolName, toolInput, toolOutput) => {
        this.currentTurn++;

        // Log turn
        this.storage.addTurn({
          sessionId: this.sessionId,
          turnNumber: this.currentTurn,
          storyId: this.currentStory?.id,
          toolName,
          toolInput,
          toolOutput: typeof toolOutput === 'string' ? toolOutput.substring(0, 10000) : JSON.stringify(toolOutput).substring(0, 10000),
        });

        // Update session turn counts (both total and per-story)
        const currentSession = this.storage.getSession(this.sessionId);
        this.storage.updateSession(this.sessionId, {
          turnCount: (currentSession.turnCount || 0) + 1,
          storyTurnCount: (currentSession.storyTurnCount || 0) + 1,
        });

        // Check for sensitive operations
        if (this.options.sensitiveToolsEnabled && this.isSensitiveTool(toolName, toolInput)) {
          this.log('warn', `Sensitive operation detected: ${toolName}`);
          this.storage.updateSession(this.sessionId, {
            status: SessionState.WAITING_APPROVAL,
            blockingResource: `Approval needed for: ${toolName}`,
          });
          // In full implementation, would pause and wait for approval
        }

        // Checkpoint periodically
        if (this.currentTurn % this.options.checkpointInterval === 0) {
          await this.saveCheckpoint();
        }

        // Check commands between turns
        await this.processCommands();

        // Budget warnings (percentUsed already calculated above)

        if (percentUsed >= 70 && !warned70) {
          warned70 = true;
          return {
            systemMessage: `TURN BUDGET WARNING: You've used ${this.currentTurn} of ${this.options.maxTurns} turns (${Math.round(percentUsed)}%). If you're not close to completing this story, consider documenting your progress and preparing for handoff.`
          };
        }

        if (percentUsed >= 90 && !warned90) {
          warned90 = true;
          return {
            systemMessage: `TURN BUDGET CRITICAL: You've used ${this.currentTurn} of ${this.options.maxTurns} turns (${Math.round(percentUsed)}%). You MUST wrap up NOW. Document what's done and what's remaining.`
          };
        }

        return {};
      };

      // Run the agent
      for await (const message of query({
        prompt,
        options: {
          model: this.options.model,
          maxTurns: this.options.maxTurns,
          settingSources: ['project'],
          permissionMode: 'bypassPermissions',
          hooks: {
            PostToolUse: [{
              hooks: [async (context) => {
                // Extract tool info from context (SDK uses snake_case)
                const toolName = context?.tool_name || 'unknown';
                const toolInput = context?.tool_input || {};
                const toolOutput = context?.tool_response || '';
                return turnHook(toolName, toolInput, toolOutput);
              }]
            }]
          }
        },
      })) {
        // Process messages
        if (message.type === 'assistant') {
          const content = message.content || message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                fullResponse += block.text;
                // Log full text for CLI access (skip very short fragments)
                if (block.text.trim().length > 10) {
                  this.log('text', block.text);
                }
              }
              if (block.type === 'tool_use') {
                this.emit('toolUse', {
                  sessionId: this.sessionId,
                  tool: block.name,
                  input: block.input,
                });
              }
            }
          }
        }

        if (message.type === 'result') {
          if (message.result) {
            fullResponse = message.result;
          }
        }

        // Check if we should stop
        const session = this.storage.getSession(this.sessionId);
        if (session.status === SessionState.ABORTED) {
          break;
        }
      }
    } finally {
      process.chdir(originalCwd);
    }

    const duration = Date.now() - startTime;
    this.log('info', `Story iteration completed in ${Math.round(duration / 1000)}s`);

    // Check for completion signal
    const allComplete = fullResponse.includes('<promise>COMPLETE</promise>');

    return {
      allComplete,
      turnsUsed: this.currentTurn,
      duration,
    };
  }

  /**
   * Build the prompt for the current iteration
   */
  buildPrompt() {
    const prd = this.prdStorage.read();
    const prdType = prd.type || 'code';

    // Load prompts
    let promptTemplate;

    if (prdType === 'original') {
      const originalPromptPath = resolve(promptsDir, 'original.md');
      if (!existsSync(originalPromptPath)) {
        throw new Error(`original.md not found at ${originalPromptPath}`);
      }
      promptTemplate = readFileSync(originalPromptPath, 'utf-8')
        .replace(/`\.claude\/skills\/ralph\/prd\.json`/g, `\`${this.session.prdPath}\``)
        .replace(/`\.claude\/skills\/ralph\/progress\.txt`/g, `\`${this.prdStorage.progressPath}\``);
    } else {
      const basePromptPath = resolve(promptsDir, 'base.md');
      const specializedPromptPath = resolve(promptsDir, `${prdType}.md`);

      if (!existsSync(basePromptPath)) {
        throw new Error(`base.md not found at ${basePromptPath}`);
      }
      if (!existsSync(specializedPromptPath)) {
        throw new Error(`${prdType}.md not found at ${specializedPromptPath}`);
      }

      const basePrompt = readFileSync(basePromptPath, 'utf-8');
      const specializedPrompt = readFileSync(specializedPromptPath, 'utf-8');

      promptTemplate = basePrompt
        .replace(/\{\{PRD_PATH\}\}/g, this.session.prdPath)
        .replace(/\{\{PROGRESS_PATH\}\}/g, this.prdStorage.progressPath)
        + '\n\n---\n\n' + specializedPrompt;
    }

    // Flush pending guidance and prepend to prompt
    const guidance = this.flushGuidance();
    if (guidance) {
      promptTemplate = guidance + '\n\n---\n\n' + promptTemplate;
    }

    return promptTemplate;
  }

  /**
   * Format guidance based on type (typed envelope approach)
   */
  formatGuidance(guidance) {
    const { type, content, source, contextDiff } = guidance;

    let formatted = '';

    switch (type) {
      case GuidanceType.CORRECTION:
        formatted = `## CRITICAL CORRECTION from ${source || 'monitoring agent'}

**You MUST adjust your approach based on this correction:**

${content}
`;
        break;

      case GuidanceType.HINT:
        formatted = `## Hint from ${source || 'monitoring agent'}

Consider the following suggestion:

${content}
`;
        break;

      case GuidanceType.NEW_REQUIREMENT:
        formatted = `## New Requirement Added

The following requirement has been added to your task:

${content}
`;
        break;

      case GuidanceType.ENVIRONMENT_UPDATE:
        formatted = `## Environment Update

The environment has changed:

${content}
`;
        if (contextDiff) {
          formatted += `\nContext changes: ${JSON.stringify(contextDiff)}`;
        }
        break;

      default:
        formatted = `## Guidance from ${source || 'external'}

${content}
`;
    }

    return formatted;
  }

  /**
   * Flush all pending guidance and format it
   */
  flushGuidance() {
    if (this.pendingGuidance.length === 0) return null;

    const formatted = this.pendingGuidance
      .map(g => this.formatGuidance(g))
      .join('\n\n');

    this.pendingGuidance = [];
    return formatted;
  }

  /**
   * Process pending commands from the queue
   */
  async processCommands() {
    const commands = this.storage.getPendingCommands(this.sessionId);

    for (const cmd of commands) {
      this.log('info', `Processing command: ${cmd.commandType}`);

      switch (cmd.commandType) {
        case CommandType.PAUSE:
          await this.handlePause(cmd);
          break;

        case CommandType.RESUME:
          await this.handleResume(cmd);
          break;

        case CommandType.INJECT:
          await this.handleInject(cmd);
          break;

        case CommandType.ABORT:
          await this.handleAbort(cmd);
          break;

        case CommandType.SKIP:
          await this.handleSkip(cmd);
          break;

        case CommandType.APPROVE:
        case CommandType.REJECT:
          await this.handleApproval(cmd);
          break;
      }

      this.storage.markCommandProcessed(cmd.id);
    }
  }

  async handlePause(cmd) {
    const lockToken = randomBytes(16).toString('hex');

    this.storage.updateSession(this.sessionId, {
      status: SessionState.PAUSED,
      pausedAt: new Date().toISOString(),
      pausedBy: cmd.source || 'unknown',
      pauseReason: cmd.payload?.reason,
      lockToken,
      lockHolder: cmd.source,
    });

    this.log('info', `Session paused by ${cmd.source || 'unknown'}`);
    this.emit('paused', { sessionId: this.sessionId, lockToken, source: cmd.source });
  }

  async handleResume(cmd) {
    const session = this.storage.getSession(this.sessionId);

    // Check lock token if required
    if (session.lockToken && cmd.payload?.lockToken !== session.lockToken) {
      if (!cmd.payload?.force) {
        this.log('warn', `Resume rejected: invalid lock token. Locked by ${session.lockHolder}`);
        this.emit('commandRejected', {
          sessionId: this.sessionId,
          command: cmd,
          reason: `Session locked by ${session.lockHolder}`,
        });
        return;
      }
      this.log('info', `Force resume override by ${cmd.source}`);
    }

    // If guidance provided with resume, add it
    if (cmd.payload?.guidance) {
      this.pendingGuidance.push({
        type: cmd.payload.guidanceType || GuidanceType.HINT,
        content: cmd.payload.guidance,
        source: cmd.source,
      });
    }

    this.storage.updateSession(this.sessionId, {
      status: SessionState.RUNNING,
      pausedAt: null,
      pausedBy: null,
      pauseReason: null,
      lockToken: null,
      lockHolder: null,
    });

    this.log('info', `Session resumed by ${cmd.source || 'unknown'}`);
    this.emit('resumed', { sessionId: this.sessionId, source: cmd.source });
  }

  async handleInject(cmd) {
    this.pendingGuidance.push({
      type: cmd.payload?.type || GuidanceType.HINT,
      content: cmd.payload?.content || cmd.payload?.guidance,
      source: cmd.source,
      contextDiff: cmd.payload?.contextDiff,
    });

    const guidancePreview = (cmd.payload?.content || cmd.payload?.guidance || '').substring(0, 100);
    this.log('inject', `[${cmd.source || 'external'}] ${guidancePreview}`, {
      source: cmd.source,
      type: cmd.payload?.type || GuidanceType.HINT,
    });
    this.emit('guidanceInjected', { sessionId: this.sessionId, source: cmd.source });
  }

  async handleAbort(cmd) {
    this.storage.updateSession(this.sessionId, {
      status: SessionState.ABORTED,
      completedAt: new Date().toISOString(),
    });

    this.isRunning = false;
    this.log('info', `Session aborted by ${cmd.source || 'unknown'}`);
    this.emit('aborted', { sessionId: this.sessionId, source: cmd.source });
  }

  async handleSkip(cmd) {
    if (this.currentStory) {
      this.log('info', `Skipping story ${this.currentStory.id}`);
      // Mark story as skipped in progress log
      this.prdStorage.appendProgress(`
## ${new Date().toISOString()} - ${this.currentStory.id} SKIPPED
- Skipped by: ${cmd.source || 'unknown'}
- Reason: ${cmd.payload?.reason || 'No reason provided'}
---
`);
      this.emit('storySkipped', { sessionId: this.sessionId, story: this.currentStory });
    }
  }

  async handleApproval(cmd) {
    const session = this.storage.getSession(this.sessionId);

    if (session.status !== SessionState.WAITING_APPROVAL) {
      return;
    }

    if (cmd.commandType === CommandType.APPROVE) {
      this.storage.updateSession(this.sessionId, {
        status: SessionState.RUNNING,
        blockingResource: null,
      });
      this.log('info', `Operation approved by ${cmd.source}`);
    } else {
      this.storage.updateSession(this.sessionId, {
        status: SessionState.RUNNING,
        blockingResource: null,
      });
      this.pendingGuidance.push({
        type: GuidanceType.CORRECTION,
        content: `The operation was REJECTED. ${cmd.payload?.reason || 'Do not proceed with that action.'}`,
        source: cmd.source,
      });
      this.log('info', `Operation rejected by ${cmd.source}`);
    }
  }

  /**
   * Wait for resume command
   */
  async waitForResume() {
    while (true) {
      await this.sleep(1000);
      await this.processCommands();

      const session = this.storage.getSession(this.sessionId);
      if (session.status === SessionState.RUNNING) {
        break;
      }
      if (session.status === SessionState.ABORTED) {
        break;
      }
    }
  }

  /**
   * Check if a tool operation is sensitive
   */
  isSensitiveTool(toolName, toolInput) {
    const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);

    for (const pattern of SENSITIVE_TOOLS) {
      if (inputStr.includes(pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Save checkpoint for time travel
   */
  async saveCheckpoint() {
    const prd = this.prdStorage.read();
    const progress = this.prdStorage.readProgress();

    this.storage.saveCheckpoint(
      this.sessionId,
      this.currentTurn,
      JSON.stringify(prd),
      progress
    );

    this.log('debug', `Checkpoint saved at turn ${this.currentTurn}`);
  }

  /**
   * Restore from checkpoint (for time travel)
   */
  async restoreCheckpoint(turnNumber) {
    const checkpoint = this.storage.getCheckpoint(this.sessionId, turnNumber);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found for turn ${turnNumber}`);
    }

    // Restore PRD
    this.prdStorage.write(JSON.parse(checkpoint.prdSnapshot));

    // Restore progress (optional, might want to append instead)
    // For now, we won't restore progress as it's append-only

    this.log('info', `Restored to checkpoint at turn ${turnNumber}`);
    return checkpoint;
  }

  /**
   * Update health status with analysis
   */
  updateHealth(health, reason = null) {
    const updates = { health };

    if (health === HealthState.STUCK || health === HealthState.CRITICAL) {
      updates.lastError = reason;
      updates.lastErrorTurn = this.currentTurn;
    }

    if (reason) {
      updates.blockingResource = reason;
    }

    this.storage.updateSession(this.sessionId, updates);
    this.emit('healthChanged', { sessionId: this.sessionId, health, reason });
  }

  /**
   * Extract human-readable context from tool input
   */
  getToolContext(toolName, toolInput) {
    if (!toolInput) return '';

    switch (toolName) {
      case 'Bash':
        return toolInput.command ? toolInput.command.substring(0, 100) : '';
      case 'Read':
        return toolInput.file_path || '';
      case 'Write':
        return toolInput.file_path || '';
      case 'Edit':
        return toolInput.file_path || '';
      case 'Grep':
        const pattern = toolInput.pattern || '';
        const path = toolInput.path || '.';
        return `"${pattern}" in ${path}`;
      case 'Glob':
        return toolInput.pattern || '';
      case 'WebFetch':
        return toolInput.url || '';
      case 'WebSearch':
        return toolInput.query || '';
      case 'Task':
        return toolInput.description || toolInput.prompt?.substring(0, 50) || '';
      case 'TodoWrite':
        const count = toolInput.todos?.length || 0;
        return `${count} items`;
      default:
        // Try to find a useful field
        if (typeof toolInput === 'string') return toolInput.substring(0, 50);
        if (toolInput.path) return toolInput.path;
        if (toolInput.file) return toolInput.file;
        if (toolInput.command) return toolInput.command.substring(0, 50);
        return '';
    }
  }

  /**
   * Format tool output for logging (truncated snippet)
   */
  formatToolOutput(output, maxLen = 200) {
    if (!output) return '';
    const str = typeof output === 'string' ? output : JSON.stringify(output);
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen) + '...';
  }

  /**
   * Log to storage and emit event
   */
  log(level, message, metadata = null) {
    this.storage.addLog(this.sessionId, level, message, metadata);
    this.emit('log', { sessionId: this.sessionId, level, message, metadata, timestamp: new Date().toISOString() });
  }

  /**
   * Utility sleep function
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stop the engine gracefully
   */
  stop() {
    this.isRunning = false;
  }
}

export default TurnEngine;
