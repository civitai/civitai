#!/usr/bin/env node

/**
 * Discord CLI - Post messages and announcements to Discord channels
 */

import {
  loadEnv,
  getMe,
  getGuilds,
  getGuildChannels,
  findGuild,
  findChannel,
  sendMessage,
  sendEmbed,
  getDefaultGuildId,
  getGuildMembers,
  getGuildRoles,
  getChannelMessages,
  findUser,
  findRole,
  formatUserMention,
  formatRoleMention,
  editMessage,
  deleteMessage,
  replyToMessage,
  sendRichEmbed,
  addReaction,
  removeReaction,
  pinMessage,
  unpinMessage,
  getPinnedMessages,
  createThread,
  createThreadWithoutMessage,
  parseMessageLink,
  sendDM,
  getDMMessages,
} from './api/client.mjs';

// Load environment
loadEnv();

// Parse arguments
const args = process.argv.slice(2);
let command = null;
let target = null;
let message = null;
let jsonOutput = false;
let embedTitle = null;
let embedColor = '#1E88E5'; // Default blue
let embedFooter = null;
let embedUrl = null;
let limit = null;
let embedFields = [];
let embedThumbnail = null;
let embedImage = null;
let threadName = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--title' && args[i + 1]) {
    embedTitle = args[++i];
  } else if (arg === '--color' && args[i + 1]) {
    embedColor = args[++i];
  } else if (arg === '--footer' && args[i + 1]) {
    embedFooter = args[++i];
  } else if (arg === '--url' && args[i + 1]) {
    embedUrl = args[++i];
  } else if ((arg === '--limit' || arg === '-n') && args[i + 1]) {
    limit = parseInt(args[++i], 10);
  } else if (arg === '--field' && args[i + 1]) {
    // Format: "Name|Value" or "Name|Value|inline"
    const fieldStr = args[++i];
    const parts = fieldStr.split('|');
    if (parts.length >= 2) {
      embedFields.push({
        name: parts[0],
        value: parts[1],
        inline: parts[2] === 'true' || parts[2] === 'inline',
      });
    }
  } else if (arg === '--thumbnail' && args[i + 1]) {
    embedThumbnail = args[++i];
  } else if (arg === '--image' && args[i + 1]) {
    embedImage = args[++i];
  } else if (arg === '--thread' && args[i + 1]) {
    threadName = args[++i];
  } else if (!arg.startsWith('-')) {
    if (!command) {
      command = arg;
    } else if (!target) {
      target = arg;
    } else if (!message) {
      message = arg;
    }
  }
}

// Convert hex color to decimal
function hexToDecimal(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

// Format channel list
function formatChannels(channels, guildName, guildId) {
  const textChannels = channels
    .filter(c => c.type === 0)
    .sort((a, b) => a.position - b.position);

  let output = `${guildName} (${guildId})\n`;
  for (const channel of textChannels) {
    output += `  ${channel.name} (${channel.id})\n`;
  }
  output += `\nTotal: ${textChannels.length} text channel(s)`;
  return output;
}

// Format guild list
function formatGuilds(guilds) {
  let output = 'Guilds:\n';
  for (const guild of guilds) {
    output += `  ${guild.name} (${guild.id})\n`;
  }
  output += `\nTotal: ${guilds.length} guild(s)`;
  return output;
}

// Format members list
function formatMembers(members) {
  let output = 'Members:\n';
  for (const member of members) {
    const displayName = member.nick || member.user.global_name || member.user.username;
    const username = member.user.username;
    const mention = formatUserMention(member.user.id);
    output += `  ${displayName} (@${username}) - ${mention}\n`;
  }
  output += `\nTotal: ${members.length} member(s)`;
  return output;
}

// Format roles list
function formatRoles(roles) {
  // Sort by position (highest first), exclude @everyone
  const sortedRoles = roles
    .filter(r => r.name !== '@everyone')
    .sort((a, b) => b.position - a.position);

  let output = 'Roles:\n';
  for (const role of sortedRoles) {
    const mention = formatRoleMention(role.id);
    const color = role.color ? `#${role.color.toString(16).padStart(6, '0')}` : 'none';
    output += `  ${role.name} - ${mention} (color: ${color})\n`;
  }
  output += `\nTotal: ${sortedRoles.length} role(s)`;
  return output;
}

// Format messages list
function formatMessages(messages, channelName) {
  let output = `Messages in #${channelName}:\n\n`;
  // Reverse to show oldest first
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    const author = msg.author.username;
    const timestamp = new Date(msg.timestamp).toLocaleString();
    const content = msg.content || '[embed/attachment]';
    output += `[${timestamp}] ${author}:\n  ${content.split('\n').join('\n  ')}\n\n`;
  }
  output += `Total: ${messages.length} message(s)`;
  return output;
}

// Main command handler
async function main() {
  try {
    switch (command) {
      case 'me': {
        const me = await getMe();
        if (jsonOutput) {
          console.log(JSON.stringify(me, null, 2));
        } else {
          console.log(`Bot: ${me.username}#${me.discriminator}`);
          console.log(`ID: ${me.id}`);
        }
        break;
      }

      case 'guilds': {
        const guilds = await getGuilds();
        if (jsonOutput) {
          console.log(JSON.stringify(guilds, null, 2));
        } else {
          console.log(formatGuilds(guilds));
        }
        break;
      }

      case 'channels': {
        let guildId;
        let guildName;

        if (target) {
          const guild = await findGuild(target);
          if (!guild) {
            console.error(`Error: Guild not found: ${target}`);
            process.exit(1);
          }
          guildId = guild.id;
          guildName = guild.name;
        } else {
          guildId = await getDefaultGuildId();
          if (!guildId) {
            console.error('Error: No guild configured. Specify a guild or set DISCORD_GUILD in .env');
            process.exit(1);
          }
          const guilds = await getGuilds();
          const guild = guilds.find(g => g.id === guildId);
          guildName = guild?.name || 'Unknown';
        }

        const channels = await getGuildChannels(guildId);
        if (jsonOutput) {
          console.log(JSON.stringify(channels, null, 2));
        } else {
          console.log(formatChannels(channels, guildName, guildId));
        }
        break;
      }

      case 'send': {
        if (!target || !message) {
          console.error('Usage: send <channel> "message"');
          process.exit(1);
        }

        const guildId = await getDefaultGuildId();
        if (!guildId) {
          console.error('Error: No guild configured. Set DISCORD_GUILD in .env');
          process.exit(1);
        }

        const channel = await findChannel(guildId, target);
        if (!channel) {
          console.error(`Error: Channel not found: ${target}`);
          process.exit(1);
        }

        const result = await sendMessage(channel.id, message);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Message sent to #${channel.name}`);
          console.log(`https://discord.com/channels/${guildId}/${channel.id}/${result.id}`);
        }
        break;
      }

      case 'announce': {
        if (!target || !message) {
          console.error('Usage: announce <channel> "message" [--title "text"] [--color "#hex"]');
          process.exit(1);
        }

        const guildId = await getDefaultGuildId();
        if (!guildId) {
          console.error('Error: No guild configured. Set DISCORD_GUILD in .env');
          process.exit(1);
        }

        const channel = await findChannel(guildId, target);
        if (!channel) {
          console.error(`Error: Channel not found: ${target}`);
          process.exit(1);
        }

        const embed = {
          description: message,
          color: hexToDecimal(embedColor),
          timestamp: new Date().toISOString(),
        };

        if (embedTitle) {
          embed.title = embedTitle;
        }
        if (embedFooter) {
          embed.footer = { text: embedFooter };
        }
        if (embedUrl) {
          embed.url = embedUrl;
        }

        const result = await sendEmbed(channel.id, { embed });
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Announcement sent to #${channel.name}`);
          console.log(`https://discord.com/channels/${guildId}/${channel.id}/${result.id}`);
        }
        break;
      }

      case 'users':
      case 'members': {
        const guildId = await getDefaultGuildId();
        if (!guildId) {
          console.error('Error: No guild configured. Set DISCORD_GUILD in .env');
          process.exit(1);
        }

        const members = await getGuildMembers(guildId, limit || 100);
        if (jsonOutput) {
          console.log(JSON.stringify(members, null, 2));
        } else {
          console.log(formatMembers(members));
        }
        break;
      }

      case 'user': {
        if (!target) {
          console.error('Usage: user <name|id>');
          process.exit(1);
        }

        const guildId = await getDefaultGuildId();
        if (!guildId) {
          console.error('Error: No guild configured. Set DISCORD_GUILD in .env');
          process.exit(1);
        }

        const member = await findUser(guildId, target);
        if (!member) {
          console.error(`Error: User not found: ${target}`);
          process.exit(1);
        }

        if (jsonOutput) {
          console.log(JSON.stringify(member, null, 2));
        } else {
          const displayName = member.nick || member.user.global_name || member.user.username;
          console.log(`User: ${displayName}`);
          console.log(`Username: @${member.user.username}`);
          console.log(`ID: ${member.user.id}`);
          console.log(`Mention: ${formatUserMention(member.user.id)}`);
          if (member.roles?.length > 0) {
            console.log(`Roles: ${member.roles.length} role(s)`);
          }
        }
        break;
      }

      case 'roles': {
        const guildId = await getDefaultGuildId();
        if (!guildId) {
          console.error('Error: No guild configured. Set DISCORD_GUILD in .env');
          process.exit(1);
        }

        const roles = await getGuildRoles(guildId);
        if (jsonOutput) {
          console.log(JSON.stringify(roles, null, 2));
        } else {
          console.log(formatRoles(roles));
        }
        break;
      }

      case 'role': {
        if (!target) {
          console.error('Usage: role <name|id>');
          process.exit(1);
        }

        const guildId = await getDefaultGuildId();
        if (!guildId) {
          console.error('Error: No guild configured. Set DISCORD_GUILD in .env');
          process.exit(1);
        }

        const role = await findRole(guildId, target);
        if (!role) {
          console.error(`Error: Role not found: ${target}`);
          process.exit(1);
        }

        if (jsonOutput) {
          console.log(JSON.stringify(role, null, 2));
        } else {
          const color = role.color ? `#${role.color.toString(16).padStart(6, '0')}` : 'none';
          console.log(`Role: ${role.name}`);
          console.log(`ID: ${role.id}`);
          console.log(`Mention: ${formatRoleMention(role.id)}`);
          console.log(`Color: ${color}`);
          console.log(`Position: ${role.position}`);
          console.log(`Mentionable: ${role.mentionable}`);
        }
        break;
      }

      case 'messages': {
        if (!target) {
          console.error('Usage: messages <channel> [--limit N]');
          process.exit(1);
        }

        const guildId = await getDefaultGuildId();
        if (!guildId) {
          console.error('Error: No guild configured. Set DISCORD_GUILD in .env');
          process.exit(1);
        }

        const channel = await findChannel(guildId, target);
        if (!channel) {
          console.error(`Error: Channel not found: ${target}`);
          process.exit(1);
        }

        const messages = await getChannelMessages(channel.id, limit || 20);
        if (jsonOutput) {
          console.log(JSON.stringify(messages, null, 2));
        } else {
          console.log(formatMessages(messages, channel.name));
        }
        break;
      }

      case 'edit': {
        // target = channel or message link, message = new content
        if (!target || !message) {
          console.error('Usage: edit <channel> <message_id> "new content"');
          console.error('   or: edit <message_link> "new content"');
          process.exit(1);
        }

        let channelId, messageId;
        const parsed = parseMessageLink(target);

        if (parsed) {
          // target is a message link
          channelId = parsed.channelId;
          messageId = parsed.messageId;
          // message is in the right place
        } else {
          // target is channel, message is message_id, need third arg for content
          const guildId = await getDefaultGuildId();
          const channel = await findChannel(guildId, target);
          if (!channel) {
            console.error(`Error: Channel not found: ${target}`);
            process.exit(1);
          }
          channelId = channel.id;
          messageId = message;
          // Get content from next positional arg
          const contentIndex = args.indexOf(message) + 1;
          const content = args.slice(contentIndex).find(a => !a.startsWith('-'));
          if (!content) {
            console.error('Usage: edit <channel> <message_id> "new content"');
            process.exit(1);
          }
          message = content;
        }

        const result = await editMessage(channelId, messageId, message);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Message edited`);
          console.log(`https://discord.com/channels/${result.guild_id || 'DM'}/${channelId}/${messageId}`);
        }
        break;
      }

      case 'delete': {
        if (!target) {
          console.error('Usage: delete <channel> <message_id>');
          console.error('   or: delete <message_link>');
          process.exit(1);
        }

        let channelId, messageId;
        const parsed = parseMessageLink(target);

        if (parsed) {
          channelId = parsed.channelId;
          messageId = parsed.messageId;
        } else {
          if (!message) {
            console.error('Usage: delete <channel> <message_id>');
            process.exit(1);
          }
          const guildId = await getDefaultGuildId();
          const channel = await findChannel(guildId, target);
          if (!channel) {
            console.error(`Error: Channel not found: ${target}`);
            process.exit(1);
          }
          channelId = channel.id;
          messageId = message;
        }

        await deleteMessage(channelId, messageId);
        console.log('Message deleted');
        break;
      }

      case 'reply': {
        if (!target || !message) {
          console.error('Usage: reply <channel> <message_id> "content"');
          console.error('   or: reply <message_link> "content"');
          process.exit(1);
        }

        let channelId, messageId, content;
        const parsed = parseMessageLink(target);

        if (parsed) {
          channelId = parsed.channelId;
          messageId = parsed.messageId;
          content = message;
        } else {
          const guildId = await getDefaultGuildId();
          const channel = await findChannel(guildId, target);
          if (!channel) {
            console.error(`Error: Channel not found: ${target}`);
            process.exit(1);
          }
          channelId = channel.id;
          messageId = message;
          // Get content from next positional arg
          const contentIndex = args.indexOf(message) + 1;
          content = args.slice(contentIndex).find(a => !a.startsWith('-'));
          if (!content) {
            console.error('Usage: reply <channel> <message_id> "content"');
            process.exit(1);
          }
        }

        const guildId = await getDefaultGuildId();
        const result = await replyToMessage(channelId, messageId, content);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Reply sent`);
          console.log(`https://discord.com/channels/${guildId}/${channelId}/${result.id}`);
        }
        break;
      }

      case 'rich-embed': {
        if (!target) {
          console.error('Usage: rich-embed <channel> [--title "..."] [--field "Name|Value|inline"] ...');
          process.exit(1);
        }

        const guildId = await getDefaultGuildId();
        if (!guildId) {
          console.error('Error: No guild configured. Set DISCORD_GUILD in .env');
          process.exit(1);
        }

        const channel = await findChannel(guildId, target);
        if (!channel) {
          console.error(`Error: Channel not found: ${target}`);
          process.exit(1);
        }

        const result = await sendRichEmbed(channel.id, {
          content: message || undefined,
          title: embedTitle,
          description: message,
          color: embedColor,
          fields: embedFields.length > 0 ? embedFields : undefined,
          footer: embedFooter,
          url: embedUrl,
          thumbnail: embedThumbnail,
          image: embedImage,
        });

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Rich embed sent to #${channel.name}`);
          console.log(`https://discord.com/channels/${guildId}/${channel.id}/${result.id}`);
        }
        break;
      }

      case 'react': {
        if (!target || !message) {
          console.error('Usage: react <channel> <message_id> <emoji>');
          console.error('   or: react <message_link> <emoji>');
          process.exit(1);
        }

        let channelId, messageId, emoji;
        const parsed = parseMessageLink(target);

        if (parsed) {
          channelId = parsed.channelId;
          messageId = parsed.messageId;
          emoji = message;
        } else {
          const guildId = await getDefaultGuildId();
          const channel = await findChannel(guildId, target);
          if (!channel) {
            console.error(`Error: Channel not found: ${target}`);
            process.exit(1);
          }
          channelId = channel.id;
          messageId = message;
          // Get emoji from next positional arg
          const emojiIndex = args.indexOf(message) + 1;
          emoji = args.slice(emojiIndex).find(a => !a.startsWith('-'));
          if (!emoji) {
            console.error('Usage: react <channel> <message_id> <emoji>');
            process.exit(1);
          }
        }

        await addReaction(channelId, messageId, emoji);
        console.log(`Reaction ${emoji} added`);
        break;
      }

      case 'unreact': {
        if (!target || !message) {
          console.error('Usage: unreact <channel> <message_id> <emoji>');
          console.error('   or: unreact <message_link> <emoji>');
          process.exit(1);
        }

        let channelId, messageId, emoji;
        const parsed = parseMessageLink(target);

        if (parsed) {
          channelId = parsed.channelId;
          messageId = parsed.messageId;
          emoji = message;
        } else {
          const guildId = await getDefaultGuildId();
          const channel = await findChannel(guildId, target);
          if (!channel) {
            console.error(`Error: Channel not found: ${target}`);
            process.exit(1);
          }
          channelId = channel.id;
          messageId = message;
          const emojiIndex = args.indexOf(message) + 1;
          emoji = args.slice(emojiIndex).find(a => !a.startsWith('-'));
          if (!emoji) {
            console.error('Usage: unreact <channel> <message_id> <emoji>');
            process.exit(1);
          }
        }

        await removeReaction(channelId, messageId, emoji);
        console.log(`Reaction ${emoji} removed`);
        break;
      }

      case 'pin': {
        if (!target) {
          console.error('Usage: pin <channel> <message_id>');
          console.error('   or: pin <message_link>');
          process.exit(1);
        }

        let channelId, messageId;
        const parsed = parseMessageLink(target);

        if (parsed) {
          channelId = parsed.channelId;
          messageId = parsed.messageId;
        } else {
          if (!message) {
            console.error('Usage: pin <channel> <message_id>');
            process.exit(1);
          }
          const guildId = await getDefaultGuildId();
          const channel = await findChannel(guildId, target);
          if (!channel) {
            console.error(`Error: Channel not found: ${target}`);
            process.exit(1);
          }
          channelId = channel.id;
          messageId = message;
        }

        await pinMessage(channelId, messageId);
        console.log('Message pinned');
        break;
      }

      case 'unpin': {
        if (!target) {
          console.error('Usage: unpin <channel> <message_id>');
          console.error('   or: unpin <message_link>');
          process.exit(1);
        }

        let channelId, messageId;
        const parsed = parseMessageLink(target);

        if (parsed) {
          channelId = parsed.channelId;
          messageId = parsed.messageId;
        } else {
          if (!message) {
            console.error('Usage: unpin <channel> <message_id>');
            process.exit(1);
          }
          const guildId = await getDefaultGuildId();
          const channel = await findChannel(guildId, target);
          if (!channel) {
            console.error(`Error: Channel not found: ${target}`);
            process.exit(1);
          }
          channelId = channel.id;
          messageId = message;
        }

        await unpinMessage(channelId, messageId);
        console.log('Message unpinned');
        break;
      }

      case 'pins': {
        if (!target) {
          console.error('Usage: pins <channel>');
          process.exit(1);
        }

        const guildId = await getDefaultGuildId();
        const channel = await findChannel(guildId, target);
        if (!channel) {
          console.error(`Error: Channel not found: ${target}`);
          process.exit(1);
        }

        const pins = await getPinnedMessages(channel.id);
        if (jsonOutput) {
          console.log(JSON.stringify(pins, null, 2));
        } else {
          console.log(`Pinned messages in #${channel.name}:\n`);
          for (const pin of pins) {
            const timestamp = new Date(pin.timestamp).toLocaleString();
            const content = pin.content || '[embed/attachment]';
            console.log(`[${timestamp}] ${pin.author.username}:`);
            console.log(`  ${content.split('\n').join('\n  ')}`);
            console.log(`  https://discord.com/channels/${guildId}/${channel.id}/${pin.id}\n`);
          }
          console.log(`Total: ${pins.length} pinned message(s)`);
        }
        break;
      }

      case 'thread': {
        if (!target) {
          console.error('Usage: thread <channel> <message_id> --thread "Thread Name"');
          console.error('   or: thread <message_link> --thread "Thread Name"');
          console.error('   or: thread <channel> --thread "Thread Name" (creates without message)');
          process.exit(1);
        }

        if (!threadName) {
          console.error('Error: --thread "Thread Name" is required');
          process.exit(1);
        }

        let channelId, messageId;
        const parsed = parseMessageLink(target);

        if (parsed) {
          channelId = parsed.channelId;
          messageId = parsed.messageId;
        } else {
          const guildId = await getDefaultGuildId();
          const channel = await findChannel(guildId, target);
          if (!channel) {
            console.error(`Error: Channel not found: ${target}`);
            process.exit(1);
          }
          channelId = channel.id;
          messageId = message; // May be undefined for thread without message
        }

        let result;
        if (messageId) {
          result = await createThread(channelId, messageId, threadName);
        } else {
          result = await createThreadWithoutMessage(channelId, threadName);
        }

        const guildId = await getDefaultGuildId();
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Thread "${threadName}" created`);
          console.log(`https://discord.com/channels/${guildId}/${result.id}`);
        }
        break;
      }

      case 'dm': {
        if (!target || !message) {
          console.error('Usage: dm <user> "message"');
          process.exit(1);
        }

        const guildId = await getDefaultGuildId();
        if (!guildId) {
          console.error('Error: No guild configured. Set DISCORD_GUILD in .env');
          process.exit(1);
        }

        // Find user by name or use ID directly
        let userId = target;
        if (!/^\d+$/.test(target)) {
          const member = await findUser(guildId, target);
          if (!member) {
            console.error(`Error: User not found: ${target}`);
            process.exit(1);
          }
          userId = member.user.id;
        }

        const result = await sendDM(userId, message);
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`DM sent to user`);
          console.log(`https://discord.com/channels/@me/${result.dmChannelId}/${result.id}`);
        }
        break;
      }

      case 'dm-messages': {
        if (!target) {
          console.error('Usage: dm-messages <user> [--limit N]');
          process.exit(1);
        }

        const guildId = await getDefaultGuildId();
        if (!guildId) {
          console.error('Error: No guild configured. Set DISCORD_GUILD in .env');
          process.exit(1);
        }

        // Find user by name or use ID directly
        let userId = target;
        let userName = target;
        if (!/^\d+$/.test(target)) {
          const member = await findUser(guildId, target);
          if (!member) {
            console.error(`Error: User not found: ${target}`);
            process.exit(1);
          }
          userId = member.user.id;
          userName = member.user.username;
        }

        const { messages, dmChannelId } = await getDMMessages(userId, limit || 20);
        if (jsonOutput) {
          console.log(JSON.stringify(messages, null, 2));
        } else {
          console.log(`DM messages with ${userName}:\n`);
          const reversed = [...messages].reverse();
          for (const msg of reversed) {
            const author = msg.author.username;
            const timestamp = new Date(msg.timestamp).toLocaleString();
            const content = msg.content || '[embed/attachment]';
            console.log(`[${timestamp}] ${author}:`);
            console.log(`  ${content.split('\n').join('\n  ')}\n`);
          }
          console.log(`Total: ${messages.length} message(s)`);
        }
        break;
      }

      case 'help':
      default:
        console.log(`Discord CLI

Commands:
  me                          Show bot information
  guilds                      List all guilds the bot is in
  channels [guild]            List text channels in a guild
  send <channel> "message"    Send a plain text message
  announce <channel> "msg"    Send a formatted announcement embed
  users                       List all members in the guild
  user <name|id>              Get user info and mention format
  roles                       List all roles in the guild
  role <name|id>              Get role info and mention format
  messages <channel>          Get recent messages from a channel
  edit <msg_link> "content"   Edit a message (bot's own messages only)
  delete <msg_link>           Delete a message
  reply <msg_link> "content"  Reply to a message
  rich-embed <channel>        Send embed with fields (use --field)
  react <msg_link> <emoji>    Add reaction to a message
  unreact <msg_link> <emoji>  Remove reaction from a message
  pin <msg_link>              Pin a message
  unpin <msg_link>            Unpin a message
  pins <channel>              List pinned messages
  thread <channel> --thread   Create a thread
  dm <user> "message"         Send a direct message to a user
  dm-messages <user>          Read DM history with a user

Options:
  --json                      Output raw JSON
  --title "text"              Set embed title
  --color "#hex"              Set embed color (default: #1E88E5)
  --footer "text"             Set embed footer
  --url "link"                Add URL to embed title
  --limit, -n <N>             Limit results (users: 100, messages: 20)
  --field "Name|Value|inline" Add field to rich embed (repeatable)
  --thumbnail "url"           Add thumbnail image to embed
  --image "url"               Add image to embed
  --thread "name"             Thread name for thread command

Examples:
  node query.mjs send dev-general "Build passed!"
  node query.mjs announce deployments "v5.0.1381" --title "Release"
  node query.mjs dm justin "Hey, check out this PR!"
  node query.mjs dm-messages justin --limit 10
  node query.mjs react <msg_link> "U+2705"
  node query.mjs rich-embed dev-general --title "Release" --field "Version|5.0|inline"
  node query.mjs thread dev-general --thread "Discussion"
`);
        break;
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
