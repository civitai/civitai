/**
 * ClickUp Space + Folder API methods — structural metadata only.
 * Used for walking the workspace tree to find lists/folders/spaces by name.
 */

import { apiRequest } from './client.mjs';

// Get all spaces in a team (small response — team-level metadata)
export async function getSpaces(teamId, options = {}) {
  const params = new URLSearchParams();
  if (options.archived) params.append('archived', 'true');
  const qs = params.toString();
  const response = await apiRequest(`/team/${teamId}/space${qs ? `?${qs}` : ''}`);
  return response.spaces || [];
}

// Get a single space
export async function getSpace(spaceId) {
  return apiRequest(`/space/${spaceId}`);
}

// Get folders in a space (includes nested lists in the response)
export async function getFolders(spaceId, options = {}) {
  const params = new URLSearchParams();
  if (options.archived) params.append('archived', 'true');
  const qs = params.toString();
  const response = await apiRequest(`/space/${spaceId}/folder${qs ? `?${qs}` : ''}`);
  return response.folders || [];
}

export async function getFolder(folderId) {
  return apiRequest(`/folder/${folderId}`);
}
