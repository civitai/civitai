import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { PaymentProvider, Prisma } from '@prisma/client';
import { subscriptionRenewalReminderEmail } from '~/server/email/templates/subscriptionRenewalReminder.email';

export const processSubscriptionsRequiringRenewal = createJob(
  'process-subscriptions-requiring-renewal',
  '0 0 * * *',
  async () => {
    // This job will run every day at midnight
    // Find all active subscriptions that have not had a renewal email sent, and send it.

    // At the moment, it will only care for Stripe subscriptions since we're in the migration phase.
    const subscriptions = await dbWrite.customerSubscription.findMany({
      where: {
        status: {
          in: ['active', 'trialing'],
        },
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

    subscriptions.forEach(async (subscription) => {
      // Send renewal email
      await subscriptionRenewalReminderEmail.send({
        user: {
          email: subscription.user.email,
          username: subscription.user.username as string,
        },
      });
      // Mark the subscription as having had a renewal email sent
    });

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
