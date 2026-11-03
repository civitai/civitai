import { addPrivateNote } from '../freshdesk-write.service';
import { plainTextToHtml } from '$lib/tickets/reply-html';

/** A private note on a ticket, from the plain text a ticket action writes. */
export const ticketNote = (id: string, text: string) =>
  addPrivateNote(id, plainTextToHtml(text) ?? '');
