/**
 * Storage Module for Ralph Daemon
 *
 * Hybrid storage approach:
 * - JSON Files: Session logs, turn history, metrics (ephemeral, high-fidelity debugging)
 * - PRD Files: PRD, progress.txt (git-tracked, human-editable)
 *
 * This version uses JSON files instead of SQLite to avoid external dependencies.
 * Per Gemini 3 Pro recommendation: Don't commit turn logs to git,
 * store them separately for UI/debugging, write summaries to progress.txt
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, 'data');

// Ensure data directory exists
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

/**
 * JSON-based Session Storage
 */
export class SessionStorage {
  constructor(storageDir = dataDir) {
    this.storageDir = storageDir;
    this.sessionsFile = resolve(storageDir, 'sessions.json');
    this.turnsDir = resolve(storageDir, 'turns');
    this.logsDir = resolve(storageDir, 'logs');
    this.commandsDir = resolve(storageDir, 'commands');
    this.checkpointsDir = resolve(storageDir, 'checkpoints');

    // Ensure directories exist
    [this.turnsDir, this.logsDir, this.commandsDir, this.checkpointsDir].forEach(dir => {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    });

    // Load or initialize sessions
    this.sessions = this.loadSessions();
    this.nextIds = { turn: 1, log: 1, command: 1, checkpoint: 1 };
  }

  loadSessions() {
    if (!existsSync(this.sessionsFile)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(this.sessionsFile, 'utf-8'));
    } catch (e) {
      return {};
    }
  }

  saveSessions() {
    writeFileSync(this.sessionsFile, JSON.stringify(this.sessions, null, 2));
  }

  // Session CRUD operations
  createSession(session) {
    const now = new Date().toISOString();
    const sessionData = {
      id: session.id,
      name: session.name || session.id,
      prdPath: session.prdPath,
      status: 'CREATED',
      model: session.model || 'sonnet',
      maxTurns: session.maxTurns || 100,
      currentStoryId: null,
      currentStoryTitle: null,
      turnCount: 0,
      storiesCompleted: 0,
      storiesTotal: session.storiesTotal || 0,
      tokensInput: 0,
      tokensOutput: 0,
      health: 'HEALTHY',
      blockingResource: null,
      lastError: null,
      lastErrorTurn: null,
      confidence: 1.0,
      pausedBy: null,
      pauseReason: null,
      lockToken: null,
      lockHolder: null,
      workingDirectory: session.workingDirectory,
      // Orchestration fields
      parentId: null,
      childIds: [],
      // Timestamps
      createdAt: now,
      startedAt: null,
      pausedAt: null,
      completedAt: null,
      updatedAt: now,
    };

    this.sessions[session.id] = sessionData;
    this.saveSessions();
    return sessionData;
  }

  getSession(id) {
    return this.sessions[id] || null;
  }

  getAllSessions() {
    return Object.values(this.sessions).sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  getActiveSessions() {
    const activeStatuses = ['CREATED', 'RUNNING', 'PAUSED', 'WAITING', 'WAITING_APPROVAL'];
    return this.getAllSessions().filter(s => activeStatuses.includes(s.status));
  }

  updateSession(id, updates) {
    if (!this.sessions[id]) return null;

    const session = this.sessions[id];
    for (const [key, value] of Object.entries(updates)) {
      if (key in session) {
        session[key] = value;
      }
    }
    session.updatedAt = new Date().toISOString();

    this.saveSessions();
    return session;
  }

  deleteSession(id) {
    // Delete session turns
    const turnsFile = resolve(this.turnsDir, `${id}.json`);
    if (existsSync(turnsFile)) unlinkSync(turnsFile);

    // Delete session logs
    const logsFile = resolve(this.logsDir, `${id}.json`);
    if (existsSync(logsFile)) unlinkSync(logsFile);

    // Delete session commands
    const commandsFile = resolve(this.commandsDir, `${id}.json`);
    if (existsSync(commandsFile)) unlinkSync(commandsFile);

    // Delete session checkpoints
    const checkpointsFile = resolve(this.checkpointsDir, `${id}.json`);
    if (existsSync(checkpointsFile)) unlinkSync(checkpointsFile);

    // Delete from sessions
    delete this.sessions[id];
    this.saveSessions();
  }

  // Turn operations
  getSessionTurns(sessionId) {
    const turnsFile = resolve(this.turnsDir, `${sessionId}.json`);
    if (!existsSync(turnsFile)) return [];
    try {
      return JSON.parse(readFileSync(turnsFile, 'utf-8'));
    } catch (e) {
      return [];
    }
  }

  saveSessionTurns(sessionId, turns) {
    const turnsFile = resolve(this.turnsDir, `${sessionId}.json`);
    writeFileSync(turnsFile, JSON.stringify(turns, null, 2));
  }

  addTurn(turn) {
    const turns = this.getSessionTurns(turn.sessionId);
    const now = new Date().toISOString();

    turns.push({
      id: this.nextIds.turn++,
      sessionId: turn.sessionId,
      turnNumber: turn.turnNumber,
      storyId: turn.storyId,
      prompt: turn.prompt,
      toolName: turn.toolName,
      toolInput: typeof turn.toolInput === 'string' ? turn.toolInput : JSON.stringify(turn.toolInput),
      toolOutput: typeof turn.toolOutput === 'string' ? turn.toolOutput : JSON.stringify(turn.toolOutput),
      responseText: turn.responseText,
      durationMs: turn.durationMs,
      tokensInput: turn.tokensInput,
      tokensOutput: turn.tokensOutput,
      createdAt: now,
    });

    this.saveSessionTurns(turn.sessionId, turns);
  }

  getTurns(sessionId, limit = 100, offset = 0) {
    const turns = this.getSessionTurns(sessionId);
    // Return most recent first
    const sorted = turns.sort((a, b) => b.turnNumber - a.turnNumber);
    return sorted.slice(offset, offset + limit);
  }

  // Log operations
  getSessionLogs(sessionId) {
    const logsFile = resolve(this.logsDir, `${sessionId}.json`);
    if (!existsSync(logsFile)) return [];
    try {
      return JSON.parse(readFileSync(logsFile, 'utf-8'));
    } catch (e) {
      return [];
    }
  }

  saveSessionLogs(sessionId, logs) {
    const logsFile = resolve(this.logsDir, `${sessionId}.json`);
    // Keep only last 1000 logs per session
    const trimmed = logs.slice(-1000);
    writeFileSync(logsFile, JSON.stringify(trimmed, null, 2));
  }

  addLog(sessionId, level, message, metadata = null) {
    const logs = this.getSessionLogs(sessionId);
    const now = new Date().toISOString();

    logs.push({
      id: this.nextIds.log++,
      sessionId,
      level,
      message,
      metadata,
      createdAt: now,
    });

    this.saveSessionLogs(sessionId, logs);
  }

  getLogs(sessionId, limit = 100, offset = 0, since = null) {
    let logs = this.getSessionLogs(sessionId);

    if (since) {
      logs = logs.filter(l => new Date(l.createdAt) > new Date(since));
    }

    // Return in chronological order (oldest first), with pagination
    const sorted = logs.sort((a, b) => a.id - b.id);
    return sorted.slice(offset, offset + limit);
  }

  // Command queue operations
  getSessionCommands(sessionId) {
    const commandsFile = resolve(this.commandsDir, `${sessionId}.json`);
    if (!existsSync(commandsFile)) return [];
    try {
      return JSON.parse(readFileSync(commandsFile, 'utf-8'));
    } catch (e) {
      return [];
    }
  }

  saveSessionCommands(sessionId, commands) {
    const commandsFile = resolve(this.commandsDir, `${sessionId}.json`);
    writeFileSync(commandsFile, JSON.stringify(commands, null, 2));
  }

  queueCommand(sessionId, commandType, payload = null, source = null, priority = 'NORMAL') {
    const commands = this.getSessionCommands(sessionId);
    const now = new Date().toISOString();

    commands.push({
      id: this.nextIds.command++,
      sessionId,
      commandType,
      payload,
      source,
      priority,
      processed: false,
      createdAt: now,
      processedAt: null,
    });

    this.saveSessionCommands(sessionId, commands);
  }

  getPendingCommands(sessionId) {
    const commands = this.getSessionCommands(sessionId);

    // Filter unprocessed and sort by priority
    const priorityOrder = { 'IMMEDIATE': 0, 'HIGH': 1, 'NORMAL': 2 };
    return commands
      .filter(c => !c.processed)
      .sort((a, b) => {
        const priorityDiff = (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
        if (priorityDiff !== 0) return priorityDiff;
        return a.id - b.id;
      });
  }

  markCommandProcessed(commandId) {
    // Find which session this command belongs to
    const sessionsDir = this.commandsDir;
    const files = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];

    for (const file of files) {
      const sessionId = file.replace('.json', '');
      const commands = this.getSessionCommands(sessionId);
      const cmd = commands.find(c => c.id === commandId);

      if (cmd) {
        cmd.processed = true;
        cmd.processedAt = new Date().toISOString();
        this.saveSessionCommands(sessionId, commands);
        return;
      }
    }
  }

  // Checkpoint operations
  getSessionCheckpoints(sessionId) {
    const checkpointsFile = resolve(this.checkpointsDir, `${sessionId}.json`);
    if (!existsSync(checkpointsFile)) return [];
    try {
      return JSON.parse(readFileSync(checkpointsFile, 'utf-8'));
    } catch (e) {
      return [];
    }
  }

  saveSessionCheckpoints(sessionId, checkpoints) {
    const checkpointsFile = resolve(this.checkpointsDir, `${sessionId}.json`);
    writeFileSync(checkpointsFile, JSON.stringify(checkpoints, null, 2));
  }

  saveCheckpoint(sessionId, turnNumber, prdSnapshot, progressSnapshot = null, conversationState = null) {
    const checkpoints = this.getSessionCheckpoints(sessionId);
    const now = new Date().toISOString();

    checkpoints.push({
      id: this.nextIds.checkpoint++,
      sessionId,
      turnNumber,
      prdSnapshot,
      progressSnapshot,
      conversationState,
      createdAt: now,
    });

    // Keep only last 50 checkpoints per session
    const trimmed = checkpoints.slice(-50);
    this.saveSessionCheckpoints(sessionId, trimmed);
  }

  getCheckpoint(sessionId, turnNumber) {
    const checkpoints = this.getSessionCheckpoints(sessionId);
    return checkpoints.find(c => c.turnNumber === turnNumber) || null;
  }

  getCheckpoints(sessionId) {
    const checkpoints = this.getSessionCheckpoints(sessionId);
    return checkpoints
      .map(c => ({
        id: c.id,
        sessionId: c.sessionId,
        turnNumber: c.turnNumber,
        createdAt: c.createdAt,
      }))
      .sort((a, b) => b.turnNumber - a.turnNumber);
  }

  // Cleanup old data
  cleanupOldSessions(olderThanDays = 7) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const toDelete = [];
    for (const [id, session] of Object.entries(this.sessions)) {
      if (['COMPLETED', 'ABORTED'].includes(session.status)) {
        if (session.completedAt && new Date(session.completedAt) < cutoff) {
          toDelete.push(id);
        }
      }
    }

    for (const id of toDelete) {
      this.deleteSession(id);
    }

    return toDelete.length;
  }

  close() {
    // No-op for JSON storage, but kept for interface compatibility
  }
}

/**
 * PRD File Operations - File-based for git tracking
 */
export class PrdStorage {
  constructor(prdPath) {
    this.prdPath = prdPath;
    this.progressPath = resolve(dirname(prdPath), 'progress.txt');
  }

  exists() {
    return existsSync(this.prdPath);
  }

  read() {
    if (!this.exists()) {
      throw new Error(`PRD not found at ${this.prdPath}`);
    }
    const content = readFileSync(this.prdPath, 'utf-8');
    return JSON.parse(content);
  }

  write(prd) {
    writeFileSync(this.prdPath, JSON.stringify(prd, null, 2));
  }

  getNextStory() {
    const prd = this.read();
    const incomplete = prd.userStories
      .filter(s => !s.passes)
      .sort((a, b) => a.priority - b.priority);
    return incomplete[0] || null;
  }

  markStoryComplete(storyId) {
    const prd = this.read();
    const story = prd.userStories.find(s => s.id === storyId);
    if (story) {
      story.passes = true;
      this.write(prd);
    }
  }

  getProgress() {
    const prd = this.read();
    return {
      total: prd.userStories.length,
      completed: prd.userStories.filter(s => s.passes).length,
      remaining: prd.userStories.filter(s => !s.passes).length,
    };
  }

  // Progress log operations
  initProgressLog() {
    if (!existsSync(this.progressPath)) {
      const prd = this.read();
      const content = `# Ralph Progress Log
Started: ${new Date().toISOString()}
Feature: ${prd.description}

## Codebase Patterns
<!-- Patterns will be added as Ralph discovers them -->

---
`;
      writeFileSync(this.progressPath, content);
    }
  }

  appendProgress(entry) {
    this.initProgressLog();
    const current = readFileSync(this.progressPath, 'utf-8');
    writeFileSync(this.progressPath, current + '\n' + entry);
  }

  readProgress() {
    if (!existsSync(this.progressPath)) {
      return null;
    }
    return readFileSync(this.progressPath, 'utf-8');
  }
}

// Singleton instance
let storageInstance = null;

export function getStorage() {
  if (!storageInstance) {
    storageInstance = new SessionStorage();
  }
  return storageInstance;
}

export function closeStorage() {
  if (storageInstance) {
    storageInstance.close();
    storageInstance = null;
  }
}
