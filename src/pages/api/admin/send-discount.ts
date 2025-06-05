import type { NextApiRequest, NextApiResponse } from 'next';
import { chunk } from 'lodash-es';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createNotification } from '~/server/services/notification.service';
import { NotificationCategory } from '~/server/common/enums';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createMessage, upsertChat } from '~/server/services/chat.service';
import { getUserById } from '~/server/services/user.service';
import { ChatMessageType } from '@prisma/client';
// import data from './data.json';

const targetUsers: number[] = [];

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const batches = chunk(targetUsers, 10000);
  let i = 0;
  for (const batch of batches) {
    try {
      const url = '/pricing';
      await createNotification({
        userIds: batch,
        details: {
          message:
            'BLACK FRIDAY DEAL: Take 50% off the first month of any membership tier for a limited time, Use code CYBER2024 at checkout!',
          url,
        },
        category: NotificationCategory.Other,
        key: `black_friday_2024_${i}`,
        type: 'system-message',
      });

      const tasks = batch.map((userId) => async () => {
        const targetUser = await getUserById({ id: userId, select: { username: true } });

        if (!targetUser) {
          return;
        }

        const chat = await upsertChat({
          userIds: [3, userId],
          isModerator: true,
          isSupporter: false,
          userId: 3,
        });

        if (!chat) {
          return;
        }

        await createMessage({
          chatId: chat.id,
          content:
            `Hey ${targetUser.username},` +
            `\nWe've got a special holiday treat just for you! 🎁 Use code **CYBER2024** at checkout and save 50% on your first month of any membership tier.` +
            `\nHurry though—this offer is only available until December 6th! Don't miss your chance to unlock all the perks of membership at an unbeatable price.` +
            `\n\n\n[Sign Up Now](/pricing)` +
            `\n\n\nHappy Holidays!` +
            `\nMaxfield and the Civitai Team`,
          userId: -1, // We want this to be a system message.
          contentType: ChatMessageType.Markdown,
          isModerator: true,
        });
      });

      await limitConcurrency(tasks, 3);
      i++;
    } catch (e) {
      console.log((e as Error).message);
    }
  }
  return res.status(200).json({ data: { success: true } });
  // return res.status(200).json(await formatTextToImageResponses(items as TextToImageResponse[]));
});
