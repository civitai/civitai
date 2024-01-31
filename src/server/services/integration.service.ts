import { env } from '~/env/server.mjs';
import { getUserSettings, setUserSetting } from '~/server/services/user.service';

export async function confirmAir({ email, userId }: { email: string; userId: number }) {
  let { status } = await getAirStatus(userId);
  if (status === 'connected') throw new Error('Account already connected');

  // Call AiR Webhook
  if (env.AIR_WEBHOOK) {
    const res = await fetch(env.AIR_WEBHOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error('Failed to send confirmation to AiR');
  } else {
    console.warn('No AiR Webhook set');
  }

  await setUserSetting(userId, { airEmail: email });
  status = 'connected';
  return { status };
}

export type AirConfirmationStatus = 'pending' | 'connected';
export async function getAirStatus(userId: number) {
  let status: AirConfirmationStatus = 'pending';
  const { airEmail } = await getUserSettings(userId);
  if (airEmail) status = 'connected';

  return { status };
}
