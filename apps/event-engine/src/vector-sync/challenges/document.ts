/**
 * The challenge document: one text per challenge, embedded for semantic search and stored as
 * `search_text` for phrase filters. Never the judging prompt.
 */
import { createHash } from 'crypto';
import { cleanHtml, DOCUMENT_MAX_CHARS } from '../models/document';

export type ChallengeSource = {
  title: string;
  theme: string | null;
  invitation: string | null;
  description: string | null;
  eventTitle: string | null;
};

export function challengeDocument(challenge: ChallengeSource) {
  const text = [
    `Title: ${cleanHtml(challenge.title)}`,
    `Theme: ${cleanHtml(challenge.theme)}`,
    `Invitation: ${cleanHtml(challenge.invitation)}`,
    `Description: ${cleanHtml(challenge.description)}`,
    `Event: ${cleanHtml(challenge.eventTitle)}`,
  ]
    .join('\n')
    // Code points, so a cut never splits a surrogate pair.
    .match(/[\s\S]/gu)!
    .slice(0, DOCUMENT_MAX_CHARS)
    .join('');
  return { text, docHash: createHash('sha256').update(text).digest('hex') };
}
