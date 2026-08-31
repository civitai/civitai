/**
 * @mention support for ClickUp comments
 *
 * Two syntaxes supported:
 *   1. Explicit: @[identifier] — always preferred, resolves via fuzzy match
 *   2. Bare:     @Name or @First Last — auto-detected against workspace members
 *
 * The bare syntax is a fallback for agents that forget the brackets.
 * It matches against workspace member usernames (case-insensitive).
 *
 * Examples:
 *   @[justin]        → fuzzy matches "Justin Maier" (user 10620972)
 *   @[10620972]      → direct user ID
 *   @[jane@co.com]   → matches by email
 *   @Justin Maier    → bare match against workspace members
 *   @Justin          → bare partial match (first name only)
 */

import { findUser, getTeamId, getTeamMembers } from '../api/user.mjs';
import { markdownToClickUp } from './markdown.mjs';

/**
 * Extract @[identifier] patterns from text
 * @param {string} text
 * @returns {{ raw: string, identifier: string, index: number }[]}
 */
export function extractMentionSyntax(text) {
  const regex = /@\[([^\]]+)\]/g;
  const mentions = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    mentions.push({ raw: match[0], identifier: match[1], index: match.index });
  }
  return mentions;
}

/**
 * Detect bare @Name mentions by matching against workspace members.
 * Tries longest match first (e.g. "@Justin Maier" before "@Justin").
 * Only matches at word boundaries to avoid false positives.
 *
 * @param {string} text - Text with @[...] patterns already removed/replaced
 * @param {object[]} members - Array of { user: { id, username, email, ... } }
 * @returns {{ raw: string, userId: number, displayName: string, index: number }[]}
 */
export function detectBareMentions(text, members) {
  const found = [];

  for (const member of members) {
    const user = member.user;
    const username = user.username;
    if (!username) continue;

    // Build candidate patterns: full name, then first name
    const candidates = [`@${username}`];
    const firstName = username.split(/\s+/)[0];
    if (firstName && firstName !== username) {
      candidates.push(`@${firstName}`);
    }

    for (const candidate of candidates) {
      let searchFrom = 0;
      while (true) {
        const idx = text.toLowerCase().indexOf(candidate.toLowerCase(), searchFrom);
        if (idx === -1) break;

        const afterIdx = idx + candidate.length;
        // Ensure it's not inside an already-resolved @[...] bracket pattern
        // and the char after the match is a word boundary (space, punct, EOL)
        const charAfter = text[afterIdx];
        const isWordBoundary = !charAfter || /[\s,.:;!?)\]}>\/\-\n]/.test(charAfter);

        if (isWordBoundary) {
          // Check this position isn't already covered by a longer match
          const alreadyCovered = found.some(
            f => idx >= f.index && idx < f.index + f.raw.length
          );
          if (!alreadyCovered) {
            found.push({
              raw: text.slice(idx, afterIdx),
              userId: user.id,
              displayName: username,
              index: idx,
            });
          }
        }
        searchFrom = afterIdx;
      }
    }
  }

  // Sort by position, prefer longer matches when overlapping
  found.sort((a, b) => a.index - b.index || b.raw.length - a.raw.length);

  // Deduplicate overlapping ranges (keep longest/first)
  const deduped = [];
  for (const m of found) {
    const overlaps = deduped.some(
      d => m.index >= d.index && m.index < d.index + d.raw.length
    );
    if (!overlaps) deduped.push(m);
  }

  return deduped;
}

/**
 * Resolve mentions in text — explicit @[identifier] first, then bare @Name fallback.
 * @param {string} text - Text containing mentions
 * @returns {Promise<{ text: string, mentionMap: Map<string, number> }>}
 */
export async function resolveMentions(text) {
  const syntaxes = extractMentionSyntax(text);
  const hasBracketMentions = syntaxes.length > 0;

  // Check for bare @ patterns (outside of brackets)
  const bareAtPattern = /@(?!\[)\w/;
  const mayHaveBareMentions = bareAtPattern.test(text);

  if (!hasBracketMentions && !mayHaveBareMentions) {
    return { text, mentionMap: new Map() };
  }

  const teamId = await getTeamId();
  const mentionMap = new Map();
  let resolvedText = text;

  // Phase 1: Process explicit @[identifier] patterns (reverse order for index stability)
  for (let i = syntaxes.length - 1; i >= 0; i--) {
    const m = syntaxes[i];
    const isNumeric = /^\d+$/.test(m.identifier);

    let userId, displayName;

    if (isNumeric) {
      userId = parseInt(m.identifier);
      try {
        const user = await findUser(teamId, m.identifier);
        displayName = user?.username || user?.email || `User ${userId}`;
      } catch {
        displayName = `User ${userId}`;
      }
    } else {
      const user = await findUser(teamId, m.identifier);
      if (!user) {
        throw new Error(
          `Could not find user matching "${m.identifier}" for @mention. ` +
          `Use "me" to list users, or provide an exact username or user ID.`
        );
      }
      userId = user.id;
      displayName = user.username || user.email || `User ${userId}`;
    }

    const placeholder = `@${displayName}`;
    mentionMap.set(placeholder, userId);
    resolvedText =
      resolvedText.slice(0, m.index) + placeholder + resolvedText.slice(m.index + m.raw.length);
  }

  // Phase 2: Detect bare @Name mentions in the resolved text
  if (bareAtPattern.test(resolvedText)) {
    const members = await getTeamMembers(teamId);
    const bareMentions = detectBareMentions(resolvedText, members);

    // Replace bare mentions with normalized @DisplayName and add to map
    // Process in reverse order for index stability
    for (let i = bareMentions.length - 1; i >= 0; i--) {
      const m = bareMentions[i];
      const placeholder = `@${m.displayName}`;

      // Skip if this exact placeholder is already in the map (from bracket syntax)
      if (!mentionMap.has(placeholder)) {
        mentionMap.set(placeholder, m.userId);
      }

      // Replace the bare mention with the normalized form
      if (m.raw !== placeholder) {
        resolvedText =
          resolvedText.slice(0, m.index) + placeholder + resolvedText.slice(m.index + m.raw.length);
      }
    }
  }

  return { text: resolvedText, mentionMap };
}

/**
 * Post-process a comment array to inject mention attributes
 * Finds text items containing resolved @DisplayName strings and splits them
 * into separate items with the mention attribute.
 *
 * @param {object[]} commentArray - Output from markdownToClickUp()
 * @param {Map<string, number>} mentionMap - Map of "@DisplayName" → userId
 * @returns {object[]} - Comment array with mention attributes injected
 */
export function injectMentions(commentArray, mentionMap) {
  if (!mentionMap || mentionMap.size === 0) return commentArray;

  const result = [];

  for (const item of commentArray) {
    if (!item.text || typeof item.text !== 'string') {
      result.push(item);
      continue;
    }

    // Find all mention positions in this text item
    const positions = [];
    for (const [mentionText, userId] of mentionMap) {
      let searchFrom = 0;
      while (true) {
        const idx = item.text.indexOf(mentionText, searchFrom);
        if (idx === -1) break;
        positions.push({ start: idx, end: idx + mentionText.length, text: mentionText, userId });
        searchFrom = idx + mentionText.length;
      }
    }

    if (positions.length === 0) {
      result.push(item);
      continue;
    }

    // Sort by position
    positions.sort((a, b) => a.start - b.start);

    // Split text at mention boundaries
    let cursor = 0;
    const baseAttrs = item.attributes || {};

    for (const pos of positions) {
      if (pos.start > cursor) {
        result.push({ text: item.text.slice(cursor, pos.start), attributes: { ...baseAttrs } });
      }
      result.push({ text: pos.text, attributes: { ...baseAttrs, mention: pos.userId } });
      cursor = pos.end;
    }
    if (cursor < item.text.length) {
      result.push({ text: item.text.slice(cursor), attributes: { ...baseAttrs } });
    }
  }

  return result;
}

/**
 * Full pipeline: text with mentions → ClickUp comment array with mention attributes
 *
 * 1. Resolves @[identifier] patterns (explicit) and bare @Name patterns (auto-detected)
 * 2. Converts markdown to ClickUp format
 * 3. Injects mention attributes into the array
 *
 * @param {string} text - Markdown text with mentions (bracket or bare)
 * @returns {Promise<object[]>} - ClickUp comment array ready for the API
 */
export async function textToCommentArray(text) {
  const { text: resolvedText, mentionMap } = await resolveMentions(text);
  const commentArray = markdownToClickUp(resolvedText);
  return injectMentions(commentArray, mentionMap);
}
