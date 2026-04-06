/**
 * Session Manager for Ralph Daemon
 *
 * Manages multiple concurrent agent sessions:
 * - Create/list/get/destroy sessions
 * - Each session wraps a TurnEngine
 * - Handles session lifecycle and events
 * - Broadcasts events to subscribers (for WebSocket streaming)
 * - Parent-child session relationships (orchestration support)
 * - Cascading operations (abort parent → abort children)
 */

import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { resolve, dirname, basename } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { getStorage, PrdStorage, closeStorage } from './storage.mjs';
import { TurnEngine, SessionState, CommandType, GuidanceType } from './turn-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = resolve(__dirname, '..', 'prompts');

// Valid PRD types that have corresponding prompt files
const VALID_PRD_TYPES = ['code', 'orchestrator', 'testing'];

/**
 * Session Manager - Coordinates multiple Ralph sessions
 */
export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.storage = getStorage();
    this.engines = new Map(); // sessionId -> TurnEngine
    this.subscribers = new Map(); // sessionId -> Set<callback>

    // Recover any sessions that were running before daemon restart
    this.recoverSessions();
  }

  /**
   * Recover sessions that were running when daemon was stopped
   */
  recoverSessions() {
    const activeSessions = this.storage.getActiveSessions();

    for (const session of activeSessions) {
      if (session.status === SessionState.RUNNING) {
        // Mark as paused since we lost context
        this.storage.updateSession(session.id, {
          status: SessionState.PAUSED,
          pauseReason: 'Daemon restarted - session was running',
          pausedAt: new Date().toISOString(),
        });
      }
    }

    console.log(`Recovered ${activeSessions.length} session(s) from previous run`);
  }

  /**
   * Generate a unique session ID
   * @param {string} name - Base name for the session
   * @param {string} prefix - Optional prefix (e.g., 'child' for child sessions)
   */
  generateSessionId(name, prefix = null) {
    const shortId = randomBytes(4).toString('hex');
    const safeName = name
      ? name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().substring(0, 30)
      : 'ralph';
    return prefix ? `${prefix}-${safeName}-${shortId}` : `${safeName}-${shortId}`;
  }

  /**
   * Create a new session
   */
  async createSession(options) {
    const {
      prd,
      name,
      model = 'opus',
      maxTurns = 100,
      workingDirectory,
      autoStart = false,
      prefix = null, // Optional prefix for session ID (e.g., 'child')
    } = options;

    // Validate PRD path
    const prdPath = resolve(prd);
    if (!existsSync(prdPath)) {
      throw new Error(`PRD not found at ${prdPath}`);
    }

    // Generate session ID
    const sessionName = name || basename(dirname(prdPath));
    const sessionId = this.generateSessionId(sessionName, prefix);

    // Read PRD to get story count and validate type
    const prdStorage = new PrdStorage(prdPath);
    const prdData = prdStorage.read();

    // Validate PRD type has a corresponding prompt file
    const prdType = prdData.type || 'code';
    if (!VALID_PRD_TYPES.includes(prdType)) {
      const promptPath = resolve(promptsDir, `${prdType}.md`);
      if (!existsSync(promptPath)) {
        throw new Error(
          `Invalid PRD type "${prdType}". Valid types are: ${VALID_PRD_TYPES.join(', ')}. ` +
          `If you need a custom type, create ${promptPath} first.`
        );
      }
    }

    // Create session in storage
    const session = this.storage.createSession({
      id: sessionId,
      name: sessionName,
      prdPath,
      model,
      maxTurns,
      workingDirectory: workingDirectory || dirname(prdPath),
      storiesTotal: prdData.userStories.length,
    });

    // Create turn engine but don't start yet
    const engine = new TurnEngine(sessionId, { model, maxTurns });
    await engine.initialize();

    // Wire up events
    this.wireEngineEvents(engine, sessionId);

    // Store engine
    this.engines.set(sessionId, engine);

    this.emit('sessionCreated', session);

    // Auto-start if requested
    if (autoStart) {
      setImmediate(() => this.startSession(sessionId));
    }

    return session;
  }

  /**
   * Wire up engine events to broadcast to subscribers
   */
  wireEngineEvents(engine, sessionId) {
    const events = [
      'started', 'paused', 'resumed', 'aborted', 'completed',
      'storyStarted', 'storyCompleted', 'storySkipped',
      'text', 'toolUse', 'log', 'healthChanged', 'error',
      'guidanceInjected', 'commandRejected'
    ];

    for (const event of events) {
      engine.on(event, (data) => {
        // Broadcast to session subscribers
        const subscribers = this.subscribers.get(sessionId);
        if (subscribers) {
          for (const callback of subscribers) {
            try {
              callback({ event, ...data });
            } catch (err) {
              console.error(`Subscriber error: ${err.message}`);
            }
          }
        }

        // Re-emit on manager
        this.emit(event, data);
        this.emit('sessionEvent', { event, sessionId, ...data });
      });
    }
  }

  /**
   * Start a session
   */
  async startSession(sessionId) {
    const engine = this.engines.get(sessionId);
    if (!engine) {
      // Try to recreate engine from storage
      const session = this.storage.getSession(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      const newEngine = new TurnEngine(sessionId, {
        model: session.model,
        maxTurns: session.maxTurns,
      });
      await newEngine.initialize();
      this.wireEngineEvents(newEngine, sessionId);
      this.engines.set(sessionId, newEngine);

      // Start the new engine
      newEngine.start().catch(err => {
        console.error(`Session ${sessionId} error: ${err.message}`);
      });
      return;
    }

    // Start asynchronously
    engine.start().catch(err => {
      console.error(`Session ${sessionId} error: ${err.message}`);
    });
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId) {
    const session = this.storage.getSession(sessionId);
    if (!session) return null;

    // Add runtime info
    const engine = this.engines.get(sessionId);
    return {
      ...session,
      hasActiveEngine: !!engine,
      engineRunning: engine?.isRunning || false,
    };
  }

  /**
   * List all sessions
   */
  listSessions(filter = {}) {
    let sessions = this.storage.getAllSessions();

    // Apply filters
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      sessions = sessions.filter(s => statuses.includes(s.status));
    }

    if (filter.active) {
      const activeStatuses = [SessionState.CREATED, SessionState.RUNNING, SessionState.PAUSED, SessionState.WAITING];
      sessions = sessions.filter(s => activeStatuses.includes(s.status));
    }

    // Add runtime info
    return sessions.map(session => ({
      ...session,
      hasActiveEngine: this.engines.has(session.id),
    }));
  }

  /**
   * Pause a session
   */
  async pauseSession(sessionId, options = {}) {
    const { source, reason } = options;

    this.storage.queueCommand(sessionId, CommandType.PAUSE, { reason }, source, 'HIGH');

    // If engine exists and is running, it will process the command
    // Otherwise, just update the session directly
    const engine = this.engines.get(sessionId);
    if (!engine) {
      const session = this.storage.getSession(sessionId);
      if (session && session.status === SessionState.RUNNING) {
        const lockToken = randomBytes(16).toString('hex');
        this.storage.updateSession(sessionId, {
          status: SessionState.PAUSED,
          pausedAt: new Date().toISOString(),
          pausedBy: source,
          pauseReason: reason,
          lockToken,
          lockHolder: source,
        });
        return { lockToken };
      }
    }

    return { queued: true };
  }

  /**
   * Resume a session
   */
  async resumeSession(sessionId, options = {}) {
    const { source, guidance, guidanceType, lockToken, force } = options;

    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Check lock
    if (session.lockToken && lockToken !== session.lockToken && !force) {
      throw new Error(`Session is locked by ${session.lockHolder}. Provide correct lockToken or use force=true`);
    }

    this.storage.queueCommand(sessionId, CommandType.RESUME, {
      guidance,
      guidanceType: guidanceType || GuidanceType.HINT,
      lockToken,
      force,
    }, source, 'HIGH');

    // If no engine, create one and start it
    const engine = this.engines.get(sessionId);
    if (!engine) {
      await this.startSession(sessionId);
    }

    return { resumed: true };
  }

  /**
   * Inject guidance into a session
   */
  async injectGuidance(sessionId, options = {}) {
    const { content, type = GuidanceType.HINT, source, contextDiff } = options;

    if (!content) {
      throw new Error('Guidance content is required');
    }

    this.storage.queueCommand(sessionId, CommandType.INJECT, {
      content,
      type,
      contextDiff,
    }, source, options.priority || 'NORMAL');

    // Log immediately so it shows in UI even before session processes it
    const preview = content.substring(0, 100);
    const logMessage = `[${source || 'external'}] ${preview}`;
    this.storage.addLog(sessionId, 'inject', logMessage, {
      source,
      type,
      queued: true,
    });

    // Also broadcast to WebSocket subscribers so it shows immediately
    const subscribers = this.subscribers.get(sessionId);
    if (subscribers) {
      const logEvent = {
        event: 'log',
        sessionId,
        level: 'inject',
        message: logMessage,
        metadata: { source, type, queued: true },
        timestamp: new Date().toISOString(),
      };
      for (const callback of subscribers) {
        try {
          callback(logEvent);
        } catch (err) {
          console.error(`Subscriber error: ${err.message}`);
        }
      }
    }

    return { injected: true };
  }

  /**
   * Abort a session
   */
  async abortSession(sessionId, options = {}) {
    const { source } = options;

    const session = this.storage.getSession(sessionId);

    this.storage.queueCommand(sessionId, CommandType.ABORT, {}, source, 'IMMEDIATE');

    // Stop the engine immediately
    const engine = this.engines.get(sessionId);
    if (engine) {
      engine.stop();
      this.engines.delete(sessionId);
    }

    // Check for orphaned children and warn
    const childIds = session?.childIds || [];
    const activeChildren = childIds
      .map(id => this.storage.getSession(id))
      .filter(c => c && !['COMPLETED', 'ABORTED'].includes(c.status));

    if (activeChildren.length > 0) {
      const orphanIds = activeChildren.map(c => c.id);
      this.storage.addLog(sessionId, 'warn',
        `Session aborted with ${activeChildren.length} active children still running: ${orphanIds.join(', ')}. ` +
        `Use abort-cascade to stop children too.`
      );
      console.error(`Warning: Session ${sessionId} aborted with orphaned children: ${orphanIds.join(', ')}`);
    }

    // Update session status
    this.storage.updateSession(sessionId, {
      status: SessionState.ABORTED,
      completedAt: new Date().toISOString(),
    });

    return { aborted: true, orphanedChildren: activeChildren.map(c => c.id) };
  }

  /**
   * Skip current story
   */
  async skipStory(sessionId, options = {}) {
    const { source, reason } = options;

    this.storage.queueCommand(sessionId, CommandType.SKIP, { reason }, source, 'HIGH');

    return { queued: true };
  }

  /**
   * Approve a pending sensitive operation
   */
  async approveOperation(sessionId, options = {}) {
    const { source } = options;

    this.storage.queueCommand(sessionId, CommandType.APPROVE, {}, source, 'IMMEDIATE');

    return { approved: true };
  }

  /**
   * Reject a pending sensitive operation
   */
  async rejectOperation(sessionId, options = {}) {
    const { source, reason } = options;

    this.storage.queueCommand(sessionId, CommandType.REJECT, { reason }, source, 'IMMEDIATE');

    return { rejected: true };
  }

  /**
   * Destroy a session (cleanup)
   */
  async destroySession(sessionId) {
    // Stop engine if running
    const engine = this.engines.get(sessionId);
    if (engine) {
      engine.stop();
      this.engines.delete(sessionId);
    }

    // Remove subscribers
    this.subscribers.delete(sessionId);

    // Delete from storage
    this.storage.deleteSession(sessionId);

    return { destroyed: true };
  }

  /**
   * Get session logs
   */
  getLogs(sessionId, options = {}) {
    const { limit = 100, offset = 0, since } = options;
    return this.storage.getLogs(sessionId, limit, offset, since);
  }

  /**
   * Get session turns
   */
  getTurns(sessionId, options = {}) {
    const { limit = 100, offset = 0 } = options;
    return this.storage.getTurns(sessionId, limit, offset);
  }

  /**
   * Get PRD for a session
   */
  getPrd(sessionId) {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const prdStorage = new PrdStorage(session.prdPath);
    return prdStorage.read();
  }

  /**
   * Get checkpoints for a session
   */
  getCheckpoints(sessionId) {
    return this.storage.getCheckpoints(sessionId);
  }

  /**
   * Restore session to a checkpoint (time travel)
   */
  async restoreToCheckpoint(sessionId, turnNumber, options = {}) {
    const { source } = options;

    // Pause session first if running
    await this.pauseSession(sessionId, { source, reason: 'Restoring to checkpoint' });

    // Get engine
    let engine = this.engines.get(sessionId);
    if (!engine) {
      engine = new TurnEngine(sessionId);
      await engine.initialize();
      this.wireEngineEvents(engine, sessionId);
      this.engines.set(sessionId, engine);
    }

    // Restore checkpoint
    await engine.restoreCheckpoint(turnNumber);

    this.storage.addLog(sessionId, 'info', `Restored to checkpoint at turn ${turnNumber} by ${source || 'unknown'}`);

    return { restored: true, turnNumber };
  }

  /**
   * Subscribe to session events
   */
  subscribe(sessionId, callback) {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId).add(callback);

    // Return unsubscribe function
    return () => {
      const subs = this.subscribers.get(sessionId);
      if (subs) {
        subs.delete(callback);
      }
    };
  }

  /**
   * Get session status summary (for monitoring agent)
   */
  getSessionStatus(sessionId) {
    const session = this.storage.getSession(sessionId);
    if (!session) return null;

    return {
      id: session.id,
      name: session.name,
      status: session.status,
      health: session.health,
      blockingResource: session.blockingResource,
      lastError: session.lastError ? {
        message: session.lastError,
        turn: session.lastErrorTurn,
      } : null,
      confidence: session.confidence,
      currentStory: session.currentStoryId ? {
        id: session.currentStoryId,
        title: session.currentStoryTitle,
      } : null,
      progress: {
        storiesCompleted: session.storiesCompleted,
        storiesTotal: session.storiesTotal,
        turnCount: session.turnCount,
        storyTurnCount: session.storyTurnCount,
        maxTurns: session.maxTurns,
      },
      timing: {
        createdAt: session.createdAt,
        startedAt: session.startedAt,
        pausedAt: session.pausedAt,
        completedAt: session.completedAt,
        updatedAt: session.updatedAt,
      },
      lock: session.lockToken ? {
        holder: session.lockHolder,
        reason: session.pauseReason,
      } : null,
    };
  }

  /**
   * Cleanup old sessions
   */
  cleanup(olderThanDays = 7) {
    const deleted = this.storage.cleanupOldSessions(olderThanDays);
    return { deletedSessions: deleted };
  }

  // ========================================
  // Orchestration: Parent-Child Sessions
  // ========================================

  /**
   * Spawn a child session from a parent session
   */
  async spawnSession(parentId, options) {
    const parent = this.storage.getSession(parentId);
    if (!parent) {
      throw new Error(`Parent session ${parentId} not found`);
    }

    // Create child session with parent reference
    const childSession = await this.createSession({
      ...options,
      autoStart: false, // Don't auto-start, let parent control
      prefix: 'child', // Prefix child session IDs for clarity
    });

    // Link parent-child relationship
    this.storage.updateSession(childSession.id, {
      parentId,
    });

    // IMPORTANT: Re-fetch parent to get latest childIds (avoid race condition)
    // If two spawns happen concurrently, we need the fresh list
    const freshParent = this.storage.getSession(parentId);
    const parentChildren = freshParent.childIds || [];
    parentChildren.push(childSession.id);
    this.storage.updateSession(parentId, {
      childIds: parentChildren,
    });

    this.storage.addLog(parentId, 'info', `Spawned child session: ${childSession.id}`);
    this.storage.addLog(childSession.id, 'info', `Spawned by parent session: ${parentId}`);

    // Emit event
    this.emit('childSpawned', { parentId, childId: childSession.id });

    // Auto-start if requested
    if (options.autoStart) {
      setImmediate(() => this.startSession(childSession.id));
    }

    return {
      ...childSession,
      parentId,
    };
  }

  /**
   * Get all children of a session
   */
  getChildren(sessionId, options = {}) {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const childIds = session.childIds || [];
    let children = childIds.map(id => this.storage.getSession(id)).filter(Boolean);

    // Apply status filter
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      children = children.filter(c => statuses.includes(c.status));
    }

    // Add runtime info
    return children.map(child => ({
      ...child,
      hasActiveEngine: this.engines.has(child.id),
    }));
  }

  /**
   * Wait for all children of a session to complete
   * Returns a promise that resolves when all children are done
   */
  async waitForChildren(sessionId, options = {}) {
    const { timeout = 0, pollInterval = 2000 } = options;
    const startTime = Date.now();

    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const childIds = session.childIds || [];
    if (childIds.length === 0) {
      return { completed: true, children: [] };
    }

    // Poll until all children are in terminal state
    const terminalStates = [SessionState.COMPLETED, SessionState.ABORTED];

    return new Promise((resolve, reject) => {
      const checkChildren = () => {
        const children = this.getChildren(sessionId);
        const allDone = children.every(c => terminalStates.includes(c.status));

        if (allDone) {
          const results = children.map(c => ({
            id: c.id,
            name: c.name,
            status: c.status,
            storiesCompleted: c.storiesCompleted,
            storiesTotal: c.storiesTotal,
          }));
          resolve({ completed: true, children: results });
          return;
        }

        // Check timeout
        if (timeout > 0 && (Date.now() - startTime) > timeout) {
          const pending = children.filter(c => !terminalStates.includes(c.status));
          resolve({
            completed: false,
            timedOut: true,
            pendingChildren: pending.map(c => ({ id: c.id, status: c.status })),
          });
          return;
        }

        // Continue polling
        setTimeout(checkChildren, pollInterval);
      };

      checkChildren();
    });
  }

  /**
   * Wait for a session to have a significant state change
   * Returns when session: completes, aborts, pauses (blocked), needs approval, or finishes a story
   */
  async waitForStateChange(sessionId, options = {}) {
    const { timeout = 0, pollInterval = 2000 } = options;
    const startTime = Date.now();

    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Capture initial state
    const initialStatus = session.status;
    const initialStoriesCompleted = session.storiesCompleted || 0;

    // States that indicate something significant happened
    const significantStates = [
      SessionState.PAUSED,
      SessionState.WAITING,
      SessionState.WAITING_APPROVAL,
      SessionState.COMPLETED,
      SessionState.ABORTED,
    ];

    return new Promise((resolve, reject) => {
      const checkState = () => {
        const current = this.storage.getSession(sessionId);
        if (!current) {
          resolve({ changed: true, reason: 'session_deleted', sessionId });
          return;
        }

        // Check if status changed to a significant state
        if (current.status !== initialStatus && significantStates.includes(current.status)) {
          resolve({
            changed: true,
            reason: 'status_change',
            sessionId,
            previousStatus: initialStatus,
            currentStatus: current.status,
            storiesCompleted: current.storiesCompleted,
            storiesTotal: current.storiesTotal,
          });
          return;
        }

        // Check if a story was completed (even if status is still RUNNING)
        if ((current.storiesCompleted || 0) > initialStoriesCompleted) {
          resolve({
            changed: true,
            reason: 'story_completed',
            sessionId,
            status: current.status,
            storiesCompleted: current.storiesCompleted,
            storiesTotal: current.storiesTotal,
          });
          return;
        }

        // Check timeout
        if (timeout > 0 && (Date.now() - startTime) > timeout) {
          resolve({
            changed: false,
            reason: 'timeout',
            sessionId,
            status: current.status,
            storiesCompleted: current.storiesCompleted,
            storiesTotal: current.storiesTotal,
          });
          return;
        }

        // Continue polling
        setTimeout(checkState, pollInterval);
      };

      checkState();
    });
  }

  /**
   * Get the parent of a session
   */
  getParent(sessionId) {
    const session = this.storage.getSession(sessionId);
    if (!session || !session.parentId) {
      return null;
    }
    return this.storage.getSession(session.parentId);
  }

  /**
   * Get the full session tree (parent + all descendants)
   */
  getSessionTree(sessionId) {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const buildTree = (s) => {
      const childIds = s.childIds || [];
      const children = childIds
        .map(id => this.storage.getSession(id))
        .filter(Boolean)
        .map(child => buildTree(child));

      return {
        id: s.id,
        name: s.name,
        status: s.status,
        storiesCompleted: s.storiesCompleted,
        storiesTotal: s.storiesTotal,
        health: s.health,
        children,
      };
    };

    return buildTree(session);
  }

  /**
   * Abort a session and all its children (cascading abort)
   * Uses parallel abortion for wide trees
   */
  async abortSessionCascade(sessionId, options = {}) {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const aborted = [];

    // Recursively abort children first (depth-first, parallel for siblings)
    const childIds = session.childIds || [];
    if (childIds.length > 0) {
      const childResults = await Promise.all(
        childIds.map(childId =>
          this.abortSessionCascade(childId, {
            ...options,
            source: options.source || `cascade from ${sessionId}`,
          }).catch(err => {
            // Don't fail entire cascade if one child fails
            console.error(`Failed to abort child ${childId}: ${err.message}`);
            return { aborted: [] };
          })
        )
      );
      for (const result of childResults) {
        aborted.push(...result.aborted);
      }
    }

    // Then abort this session
    await this.abortSession(sessionId, options);
    aborted.push(sessionId);

    return { aborted };
  }

  /**
   * Shutdown manager
   */
  async shutdown() {
    // Stop all engines
    for (const [sessionId, engine] of this.engines) {
      engine.stop();
      this.storage.updateSession(sessionId, {
        status: SessionState.PAUSED,
        pauseReason: 'Daemon shutdown',
        pausedAt: new Date().toISOString(),
      });
    }

    this.engines.clear();
    this.subscribers.clear();

    closeStorage();
  }
}

// Singleton instance
let managerInstance = null;

export function getSessionManager() {
  if (!managerInstance) {
    managerInstance = new SessionManager();
  }
  return managerInstance;
}

export default SessionManager;
