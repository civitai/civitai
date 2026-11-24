package hydrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// The creator-membership validity cache of getValidCreatorMembershipMap
// (src/server/services/creator-membership.service.ts): one packed boolean per user under
// KeyMembershipValid, read with one mGet, and for the misses queryValidCreatorMembership (one
// CustomerSubscription read on dbRead, each product's metadata parsed with
// subscriptionProductMetadataSchema, the user's highest tier) written back per user with a plain SET
// for MEMBERSHIP_CACHE_TTL. CreatorMemberships answers hits only; CreatorMembershipsComputed is the
// whole function.

// MissCreatorMemberships is the computed cache's label (feed_go_cache_miss_total, FEED_GO_CACHE_WRITEBACK,
// the probe's `creator-memberships`).
const MissCreatorMemberships = "creator-memberships"

// membershipTTL is MEMBERSHIP_CACHE_TTL (CacheTTL.md).
const membershipTTL = 10 * time.Minute

// membershipTierOrder is constants.memberships.tierOrder (src/server/common/constants.ts).
var membershipTierOrder = []string{"free", "founder", "bronze", "silver", "gold"}

// sqlValidMemberships is queryValidCreatorMembership's findMany: the users' subscriptions whose status
// is none of the lapsed ones, with their product's metadata (a required relation: the join drops no
// subscription), on the replica (dbRead). No ORDER BY, as Prisma sends none: the answer does not
// depend on the rows' order (the first of the highest tier is as good as any other).
const sqlValidMemberships = `SELECT cs."userId", cs.metadata::text AS metadata, p.metadata::text AS "productMetadata"
		FROM "CustomerSubscription" cs
		JOIN "Product" p ON p.id = cs."productId"
		WHERE cs."userId" = ANY($1::int[])
		  AND cs.status NOT IN ('canceled', 'incomplete_expired', 'past_due', 'unpaid')`

// CreatorMembershipsComputed is getValidCreatorMembershipMap: the cached boolean of each user, and for
// every user without one (no key, a value that is not a packed boolean, or every user after a failed
// read, as Node's mGet throws for the batch) the origin's answer: true when the user's highest tier,
// over their subscriptions without `renewalEmailSent` and not bought with Buzz, is neither free nor
// founder. Each computed answer is written back (SET, not NX, for MEMBERSHIP_CACHE_TTL, as Node's
// best-effort `redis.packed.set`) only when FEED_GO_CACHE_WRITEBACK lists creator-memberships.
// Without s.Compute it is CreatorMemberships (a miss falls back). A product metadata that
// subscriptionProductMetadataSchema would reject, or that is read here less surely than Node reads it,
// is `membership-shape` (Node's parse throws). Under the Go-first probe a miss is recorded as one Go
// computes and looked up, never written.
func (s *Sources) CreatorMembershipsComputed(ctx context.Context, userIDs []int) (map[int]bool, error) {
	if s.Compute == nil {
		return s.CreatorMemberships(ctx, userIDs)
	}
	ids := Unique(userIDs)
	out := make(map[int]bool, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	cmds := make([]*redis.StringCmd, len(ids))
	b := NewBatch()
	if s.Packed.Redis != nil {
		b.add(s.Packed.Redis, func(ctx context.Context, p redis.Pipeliner) {
			for i, id := range ids {
				cmds[i] = p.Get(ctx, s.Packed.key(KeyMembershipValid, id))
			}
		})
	}
	b.Exec(ctx)
	var miss []int
	failed := false
	for i, id := range ids {
		if cmds[i] == nil {
			miss = append(miss, id)
			continue
		}
		raw, err := cmds[i].Bytes()
		if err != nil {
			if !errors.Is(err, redis.Nil) {
				failed = true
			}
			miss = append(miss, id)
			continue
		}
		v, err := Unpack(raw)
		if valid, ok := v.(bool); err == nil && ok {
			out[id] = valid
			continue
		}
		miss = append(miss, id)
	}
	if failed {
		// Node's mGet is one command: a failed read answers no id from the cache.
		miss, out = ids, make(map[int]bool, len(ids))
	}
	if len(miss) == 0 {
		return out, nil
	}
	c := s.Compute
	p := presenceOf(ctx)
	var records map[int]jspack.Obj
	var err error
	if p != nil {
		// The Go-first probe: the miss is recorded as one Go computes and looked up on the replica
		// (outside the shared flights and the memo), so a metadata Node's parse rejects is the same
		// fallback here; nothing is written or counted.
		p.recordComputed(MissCreatorMemberships, len(miss))
		records, err = s.lookupValidMemberships(ctx, miss)
	} else {
		records, err = c.lookupShared(ctx, MissCreatorMemberships, miss, s.lookupValidMemberships)
	}
	if err != nil {
		if p == nil {
			c.observe(MissCreatorMemberships, "error", len(miss))
		}
		if fallback.Reason(err) != "" {
			return nil, err
		}
		return nil, fallback.Wrap("membership-miss-failed", err)
	}
	if p == nil {
		c.observe(MissCreatorMemberships, "computed", len(miss))
	}
	var writes []packedWrite
	for _, id := range miss {
		valid := false
		if rec, ok := records[id]; ok {
			valid, _ = recordValue(rec, "valid").(bool)
		}
		out[id] = valid
		if p == nil && c.writes(MissCreatorMemberships) {
			writes = append(writes, packedWrite{cache: MissCreatorMemberships, id: id, key: s.Packed.key(KeyMembershipValid, id),
				val: jspack.Pack(valid), ttl: membershipTTL, overwrite: true})
		}
	}
	s.writePacked(ctx, writes)
	return out, nil
}

func recordValue(rec jspack.Obj, key string) any {
	for _, kv := range rec {
		if kv.K == key {
			return kv.V
		}
	}
	return nil
}

// lookupValidMemberships is queryValidCreatorMembership over ids: a record `{valid}` for every id (a
// total map, as Node's).
func (s *Sources) lookupValidMemberships(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	rows, err := s.Replica.Query(ctx, sqlValidMemberships, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	subs := make([]membershipSub, 0, len(maps))
	for _, m := range maps {
		uid, ok := Int(m["userId"])
		if !ok {
			return nil, fmt.Errorf("memberships: row %v", m)
		}
		meta, err := jsonColumn(m["metadata"])
		if err != nil {
			return nil, err
		}
		product, err := jsonColumn(m["productMetadata"])
		if err != nil {
			return nil, err
		}
		subs = append(subs, membershipSub{userID: uid, metadata: meta, productMetadata: product})
	}
	valid, err := validMemberships(ids, subs, s.Compute.TierMetadataKey)
	if err != nil {
		return nil, err
	}
	out := make(map[int]jspack.Obj, len(ids))
	for _, id := range ids {
		out[id] = jspack.O("valid", valid[id])
	}
	return out, nil
}

// membershipSub is one subscription row: its user, its own metadata and its product's (decoded JSON).
type membershipSub struct {
	userID                    int
	metadata, productMetadata any
}

// validMemberships is queryValidCreatorMembership's reduce over the rows, for every id: each user's
// highest tier (constants.memberships.tierOrder, the first of equals kept), skipping a subscription
// whose metadata has a truthy `renewalEmailSent` and one whose product is a Buzz purchase; valid is
// a tier that is neither free nor founder. tierKey is TIER_METADATA_KEY ("" = its default, `tier`).
func validMemberships(ids []int, subs []membershipSub, tierKey string) (map[int]bool, error) {
	if tierKey == "" {
		tierKey = "tier"
	}
	highest := map[int]string{}
	for _, sub := range subs {
		// `(sub.metadata ?? {}).renewalEmailSent`: a property of an object only.
		if o, ok := sub.metadata.(jspack.Obj); ok && jsTruthy(recordValue(o, "renewalEmailSent")) {
			continue
		}
		meta, err := parseProductMetadata(sub.productMetadata)
		if err != nil {
			return nil, err
		}
		if meta.buzzPurchase {
			continue
		}
		tier, err := meta.tierAt(tierKey)
		if err != nil {
			return nil, err
		}
		prev, seen := highest[sub.userID]
		if !seen || slices.Index(membershipTierOrder, tier) > slices.Index(membershipTierOrder, prev) {
			highest[sub.userID] = tier
		}
	}
	out := make(map[int]bool, len(ids))
	for _, id := range ids {
		tier := highest[id]
		out[id] = tier != "" && tier != "free" && tier != "founder"
	}
	return out, nil
}

// productMetadata is what validMemberships reads of a parsed product metadata.
type productMetadata struct {
	raw          jspack.Obj
	tier         string
	buzzPurchase bool
}

// errMembershipShape is a product metadata subscriptionProductMetadataSchema would reject (Node's
// parse throws, and model.getAll answers that error), or one read here less surely than Node reads
// it: Node answers it.
func errMembershipShape(field string) error {
	return fallback.Safef("membership-shape", "%s", field)
}

var (
	productTiers  = []string{"free", "founder", "bronze", "silver", "gold"}
	badgeTypes    = []string{"none", "static", "animated"}
	buzzTypes     = []string{"green", "yellow", "blue", "red"}
	nonNegNumbers = []string{"vaultSizeKb", "monthlyBuzz", "generationLimit", "quantityLimit", "queueLimit", "maxPrivateModels", "buzzPrice"}
	posNumbers    = []string{"rewardsMultiplier", "purchasesMultiplier"}
	optStrings    = []string{"badge", "supportLevel"}
	optBools      = []string{"animatedBadge", "includeWithTransaction", "buzzPurchase"}
	// plainDecimal is a string z.coerce.number reads as the number it spells.
	plainDecimal = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)
)

// schemaFields are every key subscriptionProductMetadataSchema declares.
func schemaFields() []string {
	out := []string{"tier", "badgeType", "buzzType"}
	for _, l := range [][]string{nonNegNumbers, posNumbers, optStrings, optBools} {
		out = append(out, l...)
	}
	return out
}

// parseProductMetadata is subscriptionProductMetadataSchema.parse (src/server/schema/
// subscriptions.schema.ts, a z.looseObject) for what it can reject or validMemberships reads: `tier`
// one of the product tiers (required); each optional coerced number absent, a JSON number or a plain
// decimal string, within its bound; the strings strings; the enums in their sets; the
// booleanStrings a boolean, a number (true only for 1) or a z.stringbool word. Any other value is
// membership-shape, including the ones Node would coerce (null, a boolean, a blank string, an
// exponent), which are left to Node.
func parseProductMetadata(v any) (*productMetadata, error) {
	o, ok := v.(jspack.Obj)
	if !ok {
		return nil, errMembershipShape("not an object")
	}
	has := func(k string) (any, bool) {
		for _, kv := range o {
			if kv.K == k {
				return kv.V, true
			}
		}
		return nil, false
	}
	out := &productMetadata{raw: o}
	tier, ok := has("tier")
	t, isStr := tier.(string)
	if !ok || !isStr || !slices.Contains(productTiers, t) {
		return nil, errMembershipShape("tier")
	}
	out.tier = t
	for _, k := range nonNegNumbers {
		if x, ok := has(k); ok {
			if n, ok := coercedNumber(x); !ok || n < 0 {
				return nil, errMembershipShape(k)
			}
		}
	}
	for _, k := range posNumbers {
		if x, ok := has(k); ok {
			if n, ok := coercedNumber(x); !ok || n <= 0 {
				return nil, errMembershipShape(k)
			}
		}
	}
	for _, k := range optStrings {
		if x, ok := has(k); ok {
			if _, isStr := x.(string); !isStr {
				return nil, errMembershipShape(k)
			}
		}
	}
	for k, set := range map[string][]string{"badgeType": badgeTypes, "buzzType": buzzTypes} {
		if x, ok := has(k); ok {
			if s, isStr := x.(string); !isStr || !slices.Contains(set, s) {
				return nil, errMembershipShape(k)
			}
		}
	}
	for _, k := range optBools {
		if x, ok := has(k); ok {
			b, ok := booleanString(x)
			if !ok {
				return nil, errMembershipShape(k)
			}
			if k == "buzzPurchase" {
				out.buzzPurchase = b
			}
		}
	}
	return out, nil
}

// tierAt is `productMeta?.[TIER_METADATA_KEY] ?? 'free'`: the parsed tier for `tier`; for another key
// absent from the metadata, free; a string under one the schema does not declare, as it is (the
// loose object keeps it). Any other value, and a key the schema declares (its parsed value, not the
// raw one, would be read), is membership-shape.
func (m *productMetadata) tierAt(key string) (string, error) {
	if key == "tier" {
		return m.tier, nil
	}
	if slices.Contains(schemaFields(), key) {
		return "", errMembershipShape("tier key")
	}
	v := recordValue(m.raw, key)
	switch t := v.(type) {
	case nil:
		for _, kv := range m.raw {
			if kv.K == key {
				return "", errMembershipShape("tier key") // a null: `?? 'free'` reads it as free, but rare enough to leave to Node
			}
		}
		return "free", nil
	case string:
		return t, nil
	}
	return "", errMembershipShape("tier key")
}

// coercedNumber is z.coerce.number() for a JSON number or a plain decimal string; ok false for any
// other value.
func coercedNumber(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		// jspack.FromJSON's number (JSON.parse's): out of range is ±Infinity, which z.number refuses.
		return t, !math.IsInf(t, 0) && !math.IsNaN(t)
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case string:
		if !plainDecimal.MatchString(t) {
			return 0, false
		}
		f, err := json.Number(t).Float64()
		return f, err == nil
	}
	return 0, false
}

// booleanString is booleanString() (src/utils/zod-helpers.ts): a boolean, a number (true only for
// 1), or a z.stringbool() word (case-insensitive); ok false for any other value.
func booleanString(v any) (bool, bool) {
	switch t := v.(type) {
	case bool:
		return t, true
	case float64:
		return t == 1, !math.IsInf(t, 0) && !math.IsNaN(t)
	case json.Number:
		f, err := t.Float64()
		return f == 1, err == nil
	case string:
		switch strings.ToLower(t) {
		case "true", "1", "yes", "on", "y", "enabled":
			return true, true
		case "false", "0", "no", "off", "n", "disabled":
			return false, true
		}
	}
	return false, false
}

// jsTruthy is JavaScript truthiness of a decoded JSON value.
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case json.Number:
		f, err := t.Float64()
		return err != nil || f != 0
	case string:
		return t != ""
	}
	return true
}
