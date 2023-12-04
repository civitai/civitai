import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('discord', 'magenta');

function getDiscordClient() {
  if (!env.DISCORD_BOT_TOKEN) throw new Error('No discord bot token found');
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
  return rest;
}

const getUserToken = async ({ user_id, access_token, refresh_token, expires_at }: TokenRequest) => {
  if (Date.now() / 1000 < expires_at) return access_token;

  const discord = getDiscordClient();
  const res = (await discord.post(Routes.oauth2TokenExchange(), {
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token,
    }),
    passThroughBody: true,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })) as TokenResponse;

  await dbWrite.account.updateMany({
    where: { userId: user_id, provider: 'discord' },
    data: {
      access_token: res.access_token,
      refresh_token: res.refresh_token,
      expires_at: Number(Math.round(Date.now() / 1000) + res.expires_in),
    },
  });

  return res.access_token;
};
type TokenRequest = {
  user_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
};
type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

const pushMetadata = async ({
  username,
  user_id,
  access_token,
  refresh_token,
  expires_at,
  ...metadata
}: {
  username: string;
} & TokenRequest &
  Record<DiscordMetadataKeys, unknown>) => {
  log(`Pushing metadata for ${username}`);

  // strip keys with null values out of the metadata
  Object.keys(metadata).forEach(
    (key: unknown) =>
      !metadata[key as DiscordMetadataKeys] && delete metadata[key as DiscordMetadataKeys]
  );

  try {
    access_token = await getUserToken({ user_id, access_token, refresh_token, expires_at });
    const userClient = new REST({ version: '10', authPrefix: 'Bearer' }).setToken(access_token);

    const res = await userClient.put(Routes.userApplicationRoleConnection(env.DISCORD_CLIENT_ID), {
      body: {
        platform_name: 'Civitai',
        platform_username: username,
        metadata,
      },
    });
    log(`Pushed metadata for ${username}`);
    return res;
  } catch (e) {
    log(`Failed to push metadata for ${username}`, e);
  }
};

const DiscordMetadataType = {
  number_lt: 1,
  number_gt: 2,
  number_eq: 3,
  number_neq: 4,
  datetime_lt: 5,
  datetime_gt: 6,
  boolean_eq: 7,
  boolean_neq: 8,
} as const;
type DiscordMetadataKeys = (typeof appMetadata)[number]['key'];
const appMetadata = [
  // // Consumer Stats
  // {
  //   key: 'models_downloaded',
  //   name: 'Resources Downloaded',
  //   description: 'Resources Downloaded Greater Than',
  //   type: DiscordMetadataType.number_gt,
  // },
  // {
  //   key: 'models_favorited',
  //   name: 'Resources Favorited',
  //   description: 'Resources Favorited Greater Than',
  //   type: DiscordMetadataType.number_gt,
  // },
  // {
  //   key: 'models_reviewed',
  //   name: 'Resources Reviewed',
  //   description: 'Resources Reviewed Greater Than',
  //   type: DiscordMetadataType.number_gt,
  // },
  // // User Type
  {
    key: 'user_since',
    name: 'User Since',
    description: 'Days since joining Civitai',
    type: DiscordMetadataType.datetime_gt,
  },
  // {
  //   key: 'moderator',
  //   name: 'Moderator',
  //   description: 'Is a moderator',
  //   type: DiscordMetadataType.boolean_eq,
  // },
  // {
  //   key: 'supporter',
  //   name: 'Supporter',
  //   description: 'Is a supporter',
  //   type: DiscordMetadataType.boolean_eq,
  // },
  // {
  //   key: 'supporter_since',
  //   name: 'Supporter Since',
  //   description: 'Days since becoming a supporter',
  //   type: DiscordMetadataType.datetime_gt,
  // },
  // {
  //   key: 'donator',
  //   name: 'Donator',
  //   description: 'Is a donator',
  //   type: DiscordMetadataType.boolean_eq,
  // },
  // {
  //   key: 'last_donation',
  //   name: 'Last Donation',
  //   description: 'Last donation within last X days',
  //   type: DiscordMetadataType.datetime_lt,
  // },
  // // Enthusiast Stats
  // {
  //   key: 'images',
  //   name: 'Images Uploaded',
  //   description: 'Images Uploaded Greater Than',
  //   type: DiscordMetadataType.number_gt,
  // },
  {
    key: 'last_image',
    name: 'Last Image Uploaded',
    description: 'Last image within last X days',
    type: DiscordMetadataType.datetime_lt,
  },
  // // Creator Stats
  {
    key: 'models_uploaded',
    name: 'Resources Uploaded',
    description: 'Resources Uploaded Greater Than',
    type: DiscordMetadataType.number_gt,
  },
  {
    key: 'last_upload',
    name: 'Last Resource Uploaded',
    description: 'Last resource upload within last X days',
    type: DiscordMetadataType.datetime_lt,
  },
  // {
  //   key: 'received_favorites',
  //   name: 'Favorites Received',
  //   description: 'Favorites Received Greater Than',
  //   type: DiscordMetadataType.number_gt,
  // },
  // {
  //   key: 'received_reviews',
  //   name: 'Reviews Received',
  //   description: 'Reviews Received Greater Than',
  //   type: DiscordMetadataType.number_gt,
  // },
  // {
  //   key: 'received_downloads',
  //   name: 'Downloads Received',
  //   description: 'Downloads Received Greater Than',
  //   type: DiscordMetadataType.number_gt,
  // },
  {
    key: 'rank',
    name: 'Leaderboard Rank',
    description: 'Leaderboard Rank less than',
    type: DiscordMetadataType.number_lt,
  },
] as const;

const registerMetadata = async () => {
  const discord = getDiscordClient();

  const res = await discord.put(Routes.applicationRoleConnectionMetadata(env.DISCORD_CLIENT_ID), {
    body: appMetadata,
  });
  log(`Registered ${appMetadata.length} metadata`);
  return res;
};

export type DiscordRole = {
  id: string;
  name: string;
};
const getAllRoles = async () => {
  const discord = getDiscordClient();
  if (!env.DISCORD_GUILD_ID) throw new Error('DISCORD_GUILD_ID not set');
  const res = await discord.get(Routes.guildRoles(env.DISCORD_GUILD_ID));
  return res as DiscordRole[];
};

const addRoleToUser = async (user_id: string, role_id: string) => {
  const discord = getDiscordClient();
  if (!env.DISCORD_GUILD_ID) throw new Error('DISCORD_GUILD_ID not set');
  try {
    await discord.put(Routes.guildMemberRole(env.DISCORD_GUILD_ID, user_id, role_id));
  } catch (e: any) {
    if (e.code !== 10007) throw e;
  }
};

const removeRoleFromUser = async (user_id: string, role_id: string) => {
  const discord = getDiscordClient();
  if (!env.DISCORD_GUILD_ID) throw new Error('DISCORD_GUILD_ID not set');
  try {
    await discord.delete(Routes.guildMemberRole(env.DISCORD_GUILD_ID, user_id, role_id));
  } catch (e: any) {
    if (e.code !== 10007) throw e;
  }
};

export const getDiscordId = async (userId: number) => {
  const account = await dbWrite.account.findFirst({
    where: { userId, provider: 'discord' },
    select: { providerAccountId: true },
  });
  return account?.providerAccountId;
};

export const getDiscordIds = async (userIds: number[]) => {
  const accounts = await dbWrite.account.findMany({
    where: { userId: { in: userIds }, provider: 'discord' },
    select: { userId: true, providerAccountId: true },
  });

  return new Map(accounts.map((account) => [account.userId, account.providerAccountId]));
};

export const discord = {
  registerMetadata,
  pushMetadata,
  getAllRoles,
  addRoleToUser,
  removeRoleFromUser,
  getDiscordId,
  getDiscordIds,
};

/*
Get user id using access token
GET /users/@me

/*
Add Guild Member Role using system level token
PUT/guilds/{guild.id}/members/{user.id}/roles/{role.id}
*/
