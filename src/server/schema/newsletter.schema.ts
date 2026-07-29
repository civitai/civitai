import * as z from 'zod';

export type UpdateSubscriptionSchema = z.infer<typeof updateSubscriptionSchema>;
/**
 * No `email` field: the address comes from the session. Accepting one let an anonymous caller
 * unsubscribe anybody whose address they knew, or sign a stranger up and have Beehiiv mail them
 * under our sender identity.
 *
 * Reviving anonymous signup needs more than putting the field back. Unsubscribing must always
 * require a session; subscribing may be anonymous, but only with proof the caller controls the
 * address — double opt-in on the Beehiiv publication, or a signed token like the one
 * `user.verifyEmailChange` uses — plus a rate limit. `beehiiv.setSubscription` posts
 * `reactivate_existing: true` with no confirmation step of our own.
 */
export const updateSubscriptionSchema = z.object({
  subscribed: z.boolean(),
});
