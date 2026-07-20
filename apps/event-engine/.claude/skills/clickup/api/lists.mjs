/**
 * ClickUp list API methods
 */

import { apiRequest } from './client.mjs';

// Get list details (including statuses)
export async function getList(listId) {
  const response = await apiRequest(`/list/${listId}`);
  return response;
}
