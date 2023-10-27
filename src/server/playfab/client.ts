import { ModelType, ReviewReactions } from '@prisma/client';
import { PlayFabClient, PlayFabServer } from 'playfab-sdk';
import { env } from '~/env/server.mjs';
import { LoginWithCustomID, WritePlayerEvent } from '~/server/playfab/client-wrapper';
import { redis } from '~/server/redis/client';
import { ReactionEntityType } from '~/server/schema/reaction.schema';
import { createLogger } from '~/utils/logging';

const log = createLogger('playfab', 'yellow');

let initialized = false;
function initializePlayfab() {
  if (!env.PLAYFAB_SECRET_KEY || !env.PLAYFAB_TITLE_ID) {
    console.error('Playfab not initialized, missing secret key or title id');
    return;
  }

  PlayFabServer.settings.titleId = env.PLAYFAB_TITLE_ID;
  PlayFabServer.settings.developerSecretKey = env.PLAYFAB_SECRET_KEY;

  PlayFabClient.settings.titleId = env.PLAYFAB_TITLE_ID;
  PlayFabClient.settings.developerSecretKey = env.PLAYFAB_SECRET_KEY;
  initialized = true;
}
initializePlayfab();

type User_Publish_Model = {
  eventName: 'user_publish_model';
  modelId: number;
  type: ModelType;
};

type User_Update_Model = {
  eventName: 'user_update_model';
  modelId: number;
  type: ModelType;
};

type User_Rate_ModelVersion = {
  eventName: 'user_rate_model';
  modelId: number;
  modelVersionId: number;
  rating: number;
};

type User_Favorite_Model = {
  eventName: 'user_favorite_model';
  modelId: number;
};

type User_Hide_Model = {
  eventName: 'user_hide_model';
  modelId: number;
};

type User_Hide_User = {
  eventName: 'user_hide_user';
  userId: number;
};

type User_Follow_User = {
  eventName: 'user_follow_user';
  userId: number;
};

type User_Download_Resource = {
  eventName: 'user_download_model';
  modelId: number;
  modelVersionId: number;
};

type User_React_Image = {
  eventName: 'user_react_image';
  imageId: number;
};

type User_React_Entity = {
  eventName: `user_react_${ReactionEntityType}`;
  id: number;
  reaction: ReviewReactions;
};

type User_Ask_Question = {
  eventName: 'user_ask_question';
  questionId: number;
};

type User_Answer_Question = {
  eventName: 'user_answer_question';
  questionId: number;
  answerId: number;
};

type User_Start_Membership = {
  eventName: 'user_start_membership';
  productId: string;
};

type User_Cancel_Membership = {
  eventName: 'user_cancel_membership';
  productId: string;
};

type PlayEvent =
  | User_Rate_ModelVersion
  | User_Favorite_Model
  | User_Hide_Model
  | User_Hide_User
  | User_Follow_User
  | User_Download_Resource
  | User_React_Image
  | User_React_Entity
  | User_Ask_Question
  | User_Answer_Question
  | User_Start_Membership
  | User_Publish_Model
  | User_Update_Model
  | User_Cancel_Membership;

async function getSessionTicket(userId: number) {
  const cachedSessionTicket = await redis.get(`playfab:session-ticket:${userId}`);
  if (cachedSessionTicket) return cachedSessionTicket;

  const result = await LoginWithCustomID(userId);
  if (result.status !== 'OK') return null;

  const sessionTicket = result.data.SessionTicket;
  if (!sessionTicket) return null;
  await redis.set(`playfab:session-ticket:${userId}`, sessionTicket, {
    EX: 60 * 60 * 23, // 23 hours (Session ticket is good for 24 hours)
  });

  return sessionTicket;
}

async function getPlayFabId(userId: number) {
  const cachedId = await redis.get(`playfab:playfab-id:${userId}`);
  if (cachedId) return cachedId;

  const result = await LoginWithCustomID(userId);
  if (result.status !== 'OK') return null;

  const playFabId = result.data.PlayFabId;
  if (!playFabId) return null;
  await redis.set(`playfab:playfab-id:${userId}`, playFabId, {
    EX: 60 * 60 * 24, // 24 hours
  });

  return playFabId;
}

async function trackEvent(userId: number, { eventName, ...body }: PlayEvent) {
  if (!initialized) return;

  try {
    const playFabId = await getPlayFabId(userId);
    if (!playFabId) return;

    await WritePlayerEvent(playFabId, { EventName: eventName, Body: body });
  } catch (err) {
    log('Tracking error', err);
  }
}

export const playfab = {
  trackEvent,
};
