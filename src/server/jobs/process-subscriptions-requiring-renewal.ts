import { Prisma } from '@prisma/client';
import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { subscriptionRenewalReminderEmail } from '~/server/email/templates/subscriptionRenewalReminder.email';
import { chunk } from 'lodash-es';

const pastDueCancelledCutOf = '2024-09-10 00:00:00.000';

export const processSubscriptionsRequiringRenewal = createJob(
  'process-subscriptions-requiring-renewal',
  '0 0 * * *',
  async () => {
    // This job will run every day at midnight
    // Find all active subscriptions that have not had a renewal email sent, and send it.

    // At the moment, it will only care for Stripe subscriptions since we're in the migration phase.
    const subscriptions = await dbWrite.customerSubscription.findMany({
      where: {
        OR: [
          {
            status: {
              in: ['active', 'trialing'],
            },
          },
          {
            status: {
              in: ['past_due', 'canceled'],
            },
            updatedAt: {
              gte: new Date(pastDueCancelledCutOf),
            },
          },
        ],
        // Because we set the metadata here, we don't mind lastRun.
        metadata: {
          path: ['renewalEmailSent'],
          equals: Prisma.AnyNull,
        },
        currentPeriodEnd: {
          lte: new Date(),
        },
        product: {
          provider: PaymentProvider.Stripe,
        },
      },
      include: {
        user: true,
      },
    });

    if (!subscriptions.length) {
      return;
    }

    const batches = chunk(subscriptions, 100);
    for (const batch of batches) {
      // Set new entries
      await Promise.all(
        batch.map(async (subscription) => {
          // Send renewal email
          // Disabled since we don't support purchasing subscriptions onsite for now
          // await subscriptionRenewalReminderEmail.send({
          //   user: {
          //     email: subscription.user.email,
          //     username: subscription.user.username as string,
          //   },
          // });
          // Mark the subscription as having had a renewal email sent
        })
      );
    }

    await dbWrite.customerSubscription.updateMany({
      where: {
        userId: {
          in: subscriptions.map((s) => s.userId),
        },
      },
      data: {
        metadata: {
          renewalEmailSent: true,
          renewalBonus: 5000,
        },
      },
    });
  }
);
