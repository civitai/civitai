package modelfeed

import (
	"encoding/json"
	"math"
	"sort"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// AssociationSuggested is the one AssociationType value (packages/civitai-db-schema: enum
// AssociationType { Suggested }).
const AssociationSuggested = "Suggested"

// AssocInput is getAssociatedResourcesSchema (src/server/schema/model.schema.ts) as
// model.getAssociatedResourcesCardData reads it: baseQuerySchema.extend({ fromId, type }).
type AssocInput struct {
	// FromID is `fromId` (z.number()). Only an int4 integer is ported.
	FromID int
	// Type is `type` (z.enum(AssociationType)).
	Type string
	// BrowsingLevel is `browsingLevel` as sent, before applyDomainFeature (nil = absent: the schema's
	// default, allBrowsingLevelsFlag, applies after the cap).
	BrowsingLevel *int
}

// assocSchemaKeys are the schema's keys: zod strips any other, but a key this list does not know is
// a fallback (`input-unknown-key`), so a key the app adds to the schema is never read as absent here.
var assocSchemaKeys = map[string]bool{"browsingLevel": true, "fromId": true, "type": true}

// ParseAssociated validates the decoded input map. A value the schema refuses (Node answers it with a
// 400 the sampler never mirrors) and a shape that is not ported fall back.
func ParseAssociated(m map[string]any) (*AssocInput, error) {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !assocSchemaKeys[k] && !trpcTransportKeys[k] {
			return nil, fallback.NewfSafe("input-unknown-key", fallback.Token(k), "%s", k)
		}
	}
	in := &AssocInput{}
	v, ok := m["fromId"]
	if !ok || v == nil {
		return nil, fallback.NewfSafe("input-invalid", "fromId", "fromId missing")
	}
	id, err := intIn(v, math.MinInt32, math.MaxInt32)
	if err != nil {
		// A fraction or a value past int4 reaches the query as Node binds it (a database error there):
		// not ported.
		return nil, fallback.NewfSafe("input-invalid", "fromId", "fromId: %v", err)
	}
	in.FromID = id
	if t, _ := m["type"].(string); t != AssociationSuggested {
		return nil, fallback.NewfSafe("input-invalid", "type", "type %v", m["type"])
	}
	in.Type = AssociationSuggested
	if v, ok := m["browsingLevel"]; ok {
		// null fails the schema (a default applies to undefined only); a string is turned into a number
		// by stripBlockedForNonModerator for a non-moderator only, which is not ported.
		n, isNum := v.(json.Number)
		if !isNum {
			return nil, fallback.NewfSafe("input-invalid", "browsingLevel", "browsingLevel %v", v)
		}
		lv, err := intIn(n, 0, math.MaxInt32)
		if err != nil {
			// Negative or fractional: NaN for a non-moderator, then the schema's 400; a moderator's
			// fraction reaches the query. Neither is ported.
			return nil, fallback.NewfSafe("input-invalid", "browsingLevel", "browsingLevel: %v", err)
		}
		in.BrowsingLevel = &lv
	}
	return in, nil
}
