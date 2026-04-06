/**
 * ClickUp user and team API methods
 */

import { apiRequest, appendToEnv } from './client.mjs';

// Get team ID (fetch and cache if not set)
export async function getTeamId() {
  if (process.env.CLICKUP_TEAM_ID) {
    return process.env.CLICKUP_TEAM_ID;
  }

  console.error('Fetching team ID from ClickUp...');
  const response = await apiRequest('/team');
  const teams = response.teams || [];

  if (teams.length === 0) {
    throw new Error('No teams found for this API token');
  }

  const team = teams[0];
  const teamId = team.id;

  if (appendToEnv('CLICKUP_TEAM_ID', teamId, `Team: ${team.name} (auto-detected)`)) {
    console.error(`Cached team ID ${teamId} (${team.name}) to .env\n`);
  }

  return teamId;
}

// Get current user ID (fetch and cache if not set)
export async function getUserId() {
  if (process.env.CLICKUP_USER_ID) {
    return process.env.CLICKUP_USER_ID;
  }

  console.error('Fetching user info from ClickUp...');
  const response = await apiRequest('/user');
  const user = response.user;

  if (!user) {
    throw new Error('Could not get user info');
  }

  const userId = user.id.toString();

  if (appendToEnv('CLICKUP_USER_ID', userId, `User: ${user.username} (auto-detected)`)) {
    console.error(`Cached user ID ${userId} (${user.username}) to .env\n`);
  }

  return userId;
}

// Get current user info
export async function getCurrentUser() {
  const response = await apiRequest('/user');
  return response.user;
}

// Get team members
export async function getTeamMembers(teamId) {
  const response = await apiRequest(`/team/${teamId}`);
  return response.team?.members || [];
}

// Find user by name, email, or ID
export async function findUser(teamId, query) {
  const members = await getTeamMembers(teamId);
  const queryLower = query.toLowerCase().trim();

  // Exact ID match
  const idMatch = members.find(m => m.user.id.toString() === query);
  if (idMatch) return idMatch.user;

  // Username/email match
  for (const member of members) {
    const user = member.user;
    if (
      user.username?.toLowerCase() === queryLower ||
      user.email?.toLowerCase() === queryLower ||
      user.initials?.toLowerCase() === queryLower
    ) {
      return user;
    }
  }

  // Partial match
  for (const member of members) {
    const user = member.user;
    if (
      user.username?.toLowerCase().includes(queryLower) ||
      user.email?.toLowerCase().includes(queryLower)
    ) {
      return user;
    }
  }

  return null;
}
