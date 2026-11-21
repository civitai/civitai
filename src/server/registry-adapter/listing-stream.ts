/**
 * THE LISTING STREAM: `listing@v1`, an app's store listing (card and detail fields, stats), for a
 * store read model (`apps/app-index-go/LISTINGS-READ-MODEL.md`).
 *
 * OFF unless `REGISTRY_ADAPTER_LISTING_RELAYS` names a relay ({@link parseListingRelays}): then
 * nothing about it exists, the schema is answered `end` and its document is not published. On,
 * the schema is served, but its entities and the listing schema's document on the schema stream
 * reach only a subscription whose token a listed relay presented (`act.sub`), so it can ship on
 * one registry before another: every other subscription reads it as empty and reads the schema
 * stream exactly as before. The gate admits; it never widens the ratings a subscription may read:
 * each listing reaches exactly the audiences its app entity does (`readableBy` in `entities.ts`).
 */
import { contextAudience, withListings } from '~/server/registry-adapter/audience';
import { JSON_SCHEMA_DIALECT } from '~/server/registry-adapter/collection-schema';
import { parsePrivateRelays } from '~/server/registry-adapter/private-feed';
import type { Adapter, AdapterContext } from '~/server/registry-adapter/protocol';
import { LISTING_SCHEMA } from '~/server/registry-adapter/urn';

/**
 * `REGISTRY_ADAPTER_LISTING_RELAYS`: the OAuth client ids of the relays whose subscriptions may
 * read the listing stream, as `REGISTRY_ADAPTER_PRIVATE_RELAYS` lists them. Unset or empty: off.
 */
export const parseListingRelays = parsePrivateRelays;

/** The streams the gate changes: the listing stream and the schema stream that documents it. */
const GATED: ReadonlySet<string> = new Set([LISTING_SCHEMA, JSON_SCHEMA_DIALECT]);

/** Whether this subscription's token was presented by a listed relay. */
export function admitsListings(
  relays: ReadonlySet<string>,
  reader: AdapterContext['reader']
): boolean {
  return !!reader?.actor && relays.has(reader.actor);
}

/**
 * `entities` with the listing gate applied: a subscription to a gated stream whose token a listed
 * relay presented reads with its audience admitted to listings (`withListings`, a key of its own,
 * so a cursor issued on one side of the gate is `cursor_expired` on the other). Every other stream,
 * and every other subscription, is passed through unchanged.
 */
export function gateListings(entities: Adapter, relays: ReadonlySet<string>): Adapter {
  const ctxFor = (schema: string, ctx: AdapterContext): AdapterContext =>
    GATED.has(schema) && admitsListings(relays, ctx.reader)
      ? { ...ctx, audience: withListings(contextAudience(ctx)) }
      : ctx;
  return {
    namespace: entities.namespace,
    serves: (schema) => entities.serves(schema),
    snapshot: (schema, ctx) => entities.snapshot(schema, ctxFor(schema, ctx)),
    changes: (schema, cursor, ctx) => entities.changes(schema, cursor, ctxFor(schema, ctx)),
  };
}
