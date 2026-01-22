/**
 * Discord API client - core HTTP layer and environment handling
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = resolve(__dirname, '..', '.env');
export const DISCORD_API_BASE = 'https://discord.com/api/v10';

// Get the API base URL - uses proxy if configured
export function getApiBase() {
  const proxyUrl = process.env.DISCORD_PROXY_URL;
  if (proxyUrl) {
    // Proxy URL should point to the /api endpoint
    return proxyUrl.replace(/\/$/, '') + '/api';
  }
  return DISCORD_API_BASE;
}

// For backward compatibility
export const API_BASE = DISCORD_API_BASE;

// Cached authenticated user info (from proxy headers)
let authenticatedUser = null;

// Get the authenticated user (only available when using proxy)
export function getAuthenticatedUser() {
  return authenticatedUser;
}

// Check if we're using the proxy
export function isUsingProxy() {
  return !!(process.env.DISCORD_PROXY_URL && process.env.DISCORD_PROXY_TOKEN);
}

// Format message with user attribution (for proxy users)
export function formatWithAttribution(content) {
  if (authenticatedUser && authenticatedUser.username) {
    return `**@${authenticatedUser.username}:** ${content}`;
  }
  return content;
}

// Get avatar URL for authenticated user
export function getAuthenticatedUserAvatarUrl() {
  if (authenticatedUser && authenticatedUser.userId && authenticatedUser.avatar) {
    return `https://cdn.discordapp.com/avatars/${authenticatedUser.userId}/${authenticatedUser.avatar}.png`;
  }
  return null;
}

// Load .env from skill directory
export function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    return false;
  }

  try {
    const envContent = readFileSync(ENV_PATH, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Append a value to .env file
export function appendToEnv(key, value, comment = null) {
  try {
    let content = '\n';
    if (comment) {
      content += `# ${comment}\n`;
    }
    content += `${key}=${value}\n`;
    appendFileSync(ENV_PATH, content);
    process.env[key] = value;
    return true;
  } catch (e) {
    return false;
  }
}

// Make API request - supports both direct Discord API and proxy
export async function apiRequest(endpoint, options = {}) {
  const proxyUrl = process.env.DISCORD_PROXY_URL;
  const proxyToken = process.env.DISCORD_PROXY_TOKEN;

  // Use proxy if configured
  if (proxyUrl && proxyToken) {
    const apiBase = proxyUrl.replace(/\/$/, '') + '/api';
    const url = `${apiBase}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${proxyToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    // Capture user info from proxy headers
    const userId = response.headers.get('X-Discord-User-Id');
    const username = response.headers.get('X-Discord-Username');
    const avatar = response.headers.get('X-Discord-Avatar');
    if (userId && username) {
      authenticatedUser = { userId, username, avatar };
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord API error: ${response.status} - ${text}`);
    }

    const text = await response.text();
    if (!text) {
      return {};
    }
    return JSON.parse(text);
  }

  // Fall back to direct Discord API with bot token
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('Error: Discord API credentials not configured');
    console.error('');
    console.error('Option 1 - Use Team Proxy (recommended):');
    console.error('  1. Get a token from your team\'s Discord Proxy');
    console.error('  2. Add to .env: DISCORD_PROXY_URL=https://your-proxy-url');
    console.error('  3. Add to .env: DISCORD_PROXY_TOKEN=your_token');
    console.error('');
    console.error('Option 2 - Use Bot Token directly:');
    console.error('  1. Copy env.example to .env in the skill directory');
    console.error('  2. Add your Discord Bot Token');
    console.error('  3. Create a bot at: https://discord.com/developers/applications');
    process.exit(1);
  }

  const url = `${DISCORD_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API error: ${response.status} - ${text}`);
  }

  const text = await response.text();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

// Get bot user info
export async function getMe() {
  return apiRequest('/users/@me');
}

// Get guilds the bot is in
export async function getGuilds() {
  return apiRequest('/users/@me/guilds');
}

// Get channels in a guild
export async function getGuildChannels(guildId) {
  return apiRequest(`/guilds/${guildId}/channels`);
}

// Send a message to a channel
export async function sendMessage(channelId, content) {
  return apiRequest(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

// Send an embed message to a channel
export async function sendEmbed(channelId, { content, embed }) {
  const body = {};
  if (content) body.content = content;
  if (embed) body.embeds = [embed];

  return apiRequest(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Find guild by name or ID
export async function findGuild(nameOrId) {
  const guilds = await getGuilds();

  // Try exact ID match first
  let guild = guilds.find(g => g.id === nameOrId);
  if (guild) return guild;

  // Try exact name match
  guild = guilds.find(g => g.name.toLowerCase() === nameOrId.toLowerCase());
  if (guild) return guild;

  // Try partial name match
  guild = guilds.find(g => g.name.toLowerCase().includes(nameOrId.toLowerCase()));
  return guild;
}

// Find channel by name or ID in a guild
export async function findChannel(guildId, nameOrId) {
  const channels = await getGuildChannels(guildId);
  const textChannels = channels.filter(c => c.type === 0); // Type 0 = text channel

  // Try exact ID match first
  let channel = textChannels.find(c => c.id === nameOrId);
  if (channel) return channel;

  // Try exact name match (with or without emoji prefix)
  channel = textChannels.find(c => {
    const cleanName = c.name.replace(/^[^\w-]+/, '').toLowerCase();
    return cleanName === nameOrId.toLowerCase() || c.name.toLowerCase() === nameOrId.toLowerCase();
  });
  if (channel) return channel;

  // Try partial name match
  channel = textChannels.find(c => {
    const cleanName = c.name.replace(/^[^\w-]+/, '').toLowerCase();
    return cleanName.includes(nameOrId.toLowerCase()) || c.name.toLowerCase().includes(nameOrId.toLowerCase());
  });
  return channel;
}

// Get or cache default guild ID
export async function getDefaultGuildId() {
  // Check if already cached
  if (process.env.DISCORD_GUILD_ID) {
    return process.env.DISCORD_GUILD_ID;
  }

  // Check if guild name is configured
  const guildName = process.env.DISCORD_GUILD;
  if (guildName) {
    const guild = await findGuild(guildName);
    if (guild) {
      appendToEnv('DISCORD_GUILD_ID', guild.id, `Auto-cached guild ID for "${guild.name}"`);
      return guild.id;
    }
  }

  // Fall back to first guild
  const guilds = await getGuilds();
  if (guilds.length > 0) {
    appendToEnv('DISCORD_GUILD_ID', guilds[0].id, `Auto-cached guild ID for "${guilds[0].name}"`);
    return guilds[0].id;
  }

  return null;
}

// Get guild members (users)
export async function getGuildMembers(guildId, limit = 1000) {
  return apiRequest(`/guilds/${guildId}/members?limit=${limit}`);
}

// Get guild roles
export async function getGuildRoles(guildId) {
  return apiRequest(`/guilds/${guildId}/roles`);
}

// Get channel messages
export async function getChannelMessages(channelId, limit = 50) {
  return apiRequest(`/channels/${channelId}/messages?limit=${limit}`);
}

// Find user by name, nickname, or ID
export async function findUser(guildId, query) {
  const members = await getGuildMembers(guildId);

  // Try exact ID match first
  let member = members.find(m => m.user.id === query);
  if (member) return member;

  // Try exact username match
  member = members.find(m =>
    m.user.username.toLowerCase() === query.toLowerCase() ||
    m.user.global_name?.toLowerCase() === query.toLowerCase() ||
    m.nick?.toLowerCase() === query.toLowerCase()
  );
  if (member) return member;

  // Try partial match
  member = members.find(m =>
    m.user.username.toLowerCase().includes(query.toLowerCase()) ||
    m.user.global_name?.toLowerCase().includes(query.toLowerCase()) ||
    m.nick?.toLowerCase().includes(query.toLowerCase())
  );
  return member;
}

// Find role by name or ID
export async function findRole(guildId, query) {
  const roles = await getGuildRoles(guildId);

  // Try exact ID match first
  let role = roles.find(r => r.id === query);
  if (role) return role;

  // Try exact name match
  role = roles.find(r => r.name.toLowerCase() === query.toLowerCase());
  if (role) return role;

  // Try partial match
  role = roles.find(r => r.name.toLowerCase().includes(query.toLowerCase()));
  return role;
}

// Format mention helpers
export function formatUserMention(userId) {
  return `<@${userId}>`;
}

export function formatRoleMention(roleId) {
  return `<@&${roleId}>`;
}

// Edit a message
export async function editMessage(channelId, messageId, content) {
  return apiRequest(`/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });
}

// Edit a message with embed
export async function editMessageEmbed(channelId, messageId, { content, embed }) {
  const body = {};
  if (content !== undefined) body.content = content;
  if (embed) body.embeds = [embed];

  return apiRequest(`/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// Delete a message
export async function deleteMessage(channelId, messageId) {
  return apiRequest(`/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE',
  });
}

// Reply to a message
export async function replyToMessage(channelId, messageId, content) {
  return apiRequest(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      message_reference: {
        message_id: messageId,
      },
    }),
  });
}

// Reply to a message with embed
export async function replyToMessageEmbed(channelId, messageId, { content, embed }) {
  const body = {
    message_reference: {
      message_id: messageId,
    },
  };
  if (content) body.content = content;
  if (embed) body.embeds = [embed];

  return apiRequest(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Send message with rich embed fields
export async function sendRichEmbed(channelId, { content, title, description, color, fields, footer, url, thumbnail, image, author }) {
  const embed = {};
  if (title) embed.title = title;
  if (description) embed.description = description;
  if (color) embed.color = typeof color === 'string' ? parseInt(color.replace('#', ''), 16) : color;
  if (fields) embed.fields = fields;
  if (footer) embed.footer = { text: footer };
  if (url) embed.url = url;
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (image) embed.image = { url: image };
  if (author) embed.author = author;
  embed.timestamp = new Date().toISOString();

  const body = { embeds: [embed] };
  if (content) body.content = content;

  return apiRequest(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Add reaction to a message
export async function addReaction(channelId, messageId, emoji) {
  // URL encode the emoji (for custom emoji use name:id format)
  const encodedEmoji = encodeURIComponent(emoji);
  return apiRequest(`/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`, {
    method: 'PUT',
  });
}

// Remove own reaction from a message
export async function removeReaction(channelId, messageId, emoji) {
  const encodedEmoji = encodeURIComponent(emoji);
  return apiRequest(`/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`, {
    method: 'DELETE',
  });
}

// Pin a message
export async function pinMessage(channelId, messageId) {
  return apiRequest(`/channels/${channelId}/pins/${messageId}`, {
    method: 'PUT',
  });
}

// Unpin a message
export async function unpinMessage(channelId, messageId) {
  return apiRequest(`/channels/${channelId}/pins/${messageId}`, {
    method: 'DELETE',
  });
}

// Get pinned messages
export async function getPinnedMessages(channelId) {
  return apiRequest(`/channels/${channelId}/pins`);
}

// Create a thread from a message
export async function createThread(channelId, messageId, name, autoArchiveDuration = 1440) {
  return apiRequest(`/channels/${channelId}/messages/${messageId}/threads`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      auto_archive_duration: autoArchiveDuration, // 60, 1440, 4320, 10080 minutes
    }),
  });
}

// Create a thread without a message
export async function createThreadWithoutMessage(channelId, name, autoArchiveDuration = 1440) {
  return apiRequest(`/channels/${channelId}/threads`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      auto_archive_duration: autoArchiveDuration,
      type: 11, // Public thread
    }),
  });
}

// Send message to a thread (threads are channels)
export async function sendToThread(threadId, content) {
  return sendMessage(threadId, content);
}

// Get a specific message
export async function getMessage(channelId, messageId) {
  return apiRequest(`/channels/${channelId}/messages/${messageId}`);
}

// Parse message link to extract channel and message IDs
export function parseMessageLink(link) {
  // Format: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID
  const match = link.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (match) {
    return {
      guildId: match[1],
      channelId: match[2],
      messageId: match[3],
    };
  }
  return null;
}

// Create or get DM channel with a user
export async function createDMChannel(userId) {
  return apiRequest('/users/@me/channels', {
    method: 'POST',
    body: JSON.stringify({ recipient_id: userId }),
  });
}

// Send DM to a user
export async function sendDM(userId, content) {
  const dmChannel = await createDMChannel(userId);
  return {
    ...await sendMessage(dmChannel.id, content),
    dmChannelId: dmChannel.id,
  };
}

// Send DM with embed to a user
export async function sendDMEmbed(userId, { content, embed }) {
  const dmChannel = await createDMChannel(userId);
  return {
    ...await sendEmbed(dmChannel.id, { content, embed }),
    dmChannelId: dmChannel.id,
  };
}

// Get DM messages with a user
export async function getDMMessages(userId, limit = 50) {
  const dmChannel = await createDMChannel(userId);
  return {
    messages: await getChannelMessages(dmChannel.id, limit),
    dmChannelId: dmChannel.id,
  };
}
