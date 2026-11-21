package modelfeed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"sort"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// The generation gate rules, as getCanGenerateHiddenGates (src/server/services/generation/
// generation.service.ts) reads them for canGenerate: the operator-authored rules
// (src/shared/generation/gates.ts), narrowed to the ones that gate this viewer, then the targets the
// `hidden` ones name. Only the parts canGenerate reads are ported: the `hidden` presentation, the
// version-id targets, and whether a rule names any ecosystem at all (an ecosystem target needs the
// base model's ecosystem key, which this service does not hold: such a rule falls back).

// GateRule is one stored rule, the fields gateRuleSchema keeps that canGenerate reads.
type GateRule struct {
	AvailableTo     string // moderators | testers | members | nobody
	Presentation    string // disabled | hidden | experimental
	Ecosystems      []string
	ModelVersionIDs []int
}

// GateRuleSource reads the rules (implemented by *SysGateRules).
type GateRuleSource interface {
	GateRules(ctx context.Context) ([]GateRule, error)
}

// The system-redis keys of the per-entry store (REDIS_SYS_KEYS.GENERATION in
// packages/civitai-redis/src/client.ts).
const (
	gateRulesKey         = "generation:gate-rules:by-id"
	gateRulesMigratedKey = "generation:gate-rules:migrated"
)

// SysGateRules reads the per-entry store on the system redis (gateRuleStore.read).
type SysGateRules struct {
	Sys redis.UniversalClient
}

// GateRules is gateRuleStore.read: the migration marker and every entry, each parsed on its own and
// dropped when gateRuleSchema refuses it (parseEntries). Before the marker is set Node migrates the
// legacy list (a write): `gate-rules-unmigrated`. A failed read, or an entry that is not JSON (Node's
// read throws, and getGateRuleState then answers the last rules this process read, which this
// service cannot know): `gate-rules-unreadable`.
func (s *SysGateRules) GateRules(ctx context.Context) ([]GateRule, error) {
	if s == nil || s.Sys == nil {
		return nil, fallback.New("gate-rules-unconfigured")
	}
	var marker *redis.StringCmd
	var all *redis.MapStringStringCmd
	_, err := s.Sys.Pipelined(ctx, func(p redis.Pipeliner) error {
		marker = p.Get(ctx, gateRulesMigratedKey)
		all = p.HGetAll(ctx, gateRulesKey)
		return nil
	})
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, fallback.Wrap("gate-rules-unreadable", err)
	}
	m, err := marker.Result()
	if errors.Is(err, redis.Nil) || (err == nil && m == "") {
		return nil, fallback.New("gate-rules-unmigrated")
	}
	if err != nil {
		return nil, fallback.Wrap("gate-rules-unreadable", err)
	}
	entries, err := all.Result()
	if err != nil {
		return nil, fallback.Wrap("gate-rules-unreadable", err)
	}
	return ParseGateRules(entries)
}

// ParseGateRules parses the store's values (one JSON rule per field), in field order (Object.values
// of the hash; the order changes no target set). fromJson (src/utils/json-helpers.ts) answers null for
// a value that is not JSON, which the schema then refuses: it is dropped, as any refused entry is.
func ParseGateRules(entries map[string]string) ([]GateRule, error) {
	fields := make([]string, 0, len(entries))
	for f := range entries {
		fields = append(fields, f)
	}
	sort.Strings(fields)
	out := make([]GateRule, 0, len(entries))
	for _, f := range fields {
		if r, ok := parseGateRule([]byte(entries[f])); ok {
			out = append(out, r)
		}
	}
	return out, nil
}

// parseGateRule is gateRuleSchema.safeParse over one decoded value: ok is false where zod refuses it.
// Unknown keys are stripped; `name` and the three target lists default when absent (undefined), and
// a present `null` fails them, as zod's `.default()` does.
func parseGateRule(raw []byte) (GateRule, bool) {
	var obj map[string]json.RawMessage
	if t := bytes.TrimSpace(raw); len(t) == 0 || t[0] != '{' || json.Unmarshal(t, &obj) != nil {
		return GateRule{}, false
	}
	var r GateRule
	var id string
	if !jsonString(obj["id"], &id) {
		return GateRule{}, false
	}
	if v, ok := obj["name"]; ok {
		var name string
		if !jsonString(v, &name) {
			return GateRule{}, false
		}
	}
	if !jsonString(obj["availableTo"], &r.AvailableTo) || !gateAvailableTo[r.AvailableTo] {
		return GateRule{}, false
	}
	if !jsonString(obj["presentation"], &r.Presentation) || !gatePresentations[r.Presentation] {
		return GateRule{}, false
	}
	if v, ok := obj["message"]; ok && !isJSONNull(v) {
		var msg string
		if !jsonString(v, &msg) {
			return GateRule{}, false
		}
	}
	var ok bool
	if r.Ecosystems, ok = stringList(obj, "ecosystems"); !ok {
		return GateRule{}, false
	}
	if _, ok = stringList(obj, "workflows"); !ok {
		return GateRule{}, false
	}
	if v, present := obj["modelVersionIds"]; present {
		var items []json.RawMessage
		if !isJSONArray(v) || json.Unmarshal(v, &items) != nil {
			return GateRule{}, false
		}
		for _, item := range items {
			var f float64
			t := bytes.TrimSpace(item)
			if len(t) == 0 || (t[0] != '-' && (t[0] < '0' || t[0] > '9')) || json.Unmarshal(t, &f) != nil {
				return GateRule{}, false
			}
			// z.number().int().positive(): a safe integer above zero.
			if f <= 0 || f != math.Trunc(f) || f > 9007199254740991 {
				return GateRule{}, false
			}
			r.ModelVersionIDs = append(r.ModelVersionIDs, int(f))
		}
	}
	return r, true
}

var (
	gateAvailableTo   = map[string]bool{"moderators": true, "testers": true, "members": true, "nobody": true}
	gatePresentations = map[string]bool{"disabled": true, "hidden": true, "experimental": true}
)

// bigintString is fromJson's reviver test: a string of digits ending in `n` is revived as a BigInt,
// which z.string() then refuses.
var bigintString = regexp.MustCompile(`^\d+n$`)

func jsonString(raw json.RawMessage, dst *string) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '"' && json.Unmarshal(t, dst) == nil && !bigintString.MatchString(*dst)
}

func isJSONNull(raw json.RawMessage) bool { return string(bytes.TrimSpace(raw)) == "null" }

func isJSONArray(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '['
}

// stringList is `z.array(z.string()).default([])`: absent is empty, anything but an array of strings
// is refused.
func stringList(obj map[string]json.RawMessage, key string) ([]string, bool) {
	v, present := obj[key]
	if !present {
		return nil, true
	}
	var items []json.RawMessage
	if !isJSONArray(v) || json.Unmarshal(v, &items) != nil {
		return nil, false
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		var s string
		if !jsonString(item, &s) {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

// gateApplies is applicableRulesFor's audience test for one rule (`isGatedFor`) with getCanGenerate
// HiddenGates' user: `isMember: true` (members rules never gate), and hasTestingAccess from
// resolveTestingAccess, which is true for a moderator and false signed out; for any other viewer it
// is a per-user Flipt answer this service does not evaluate (known = false).
func gateApplies(r GateRule, viewer *Viewer) (applies, known bool) {
	isMod := viewer != nil && viewer.IsModerator
	switch r.AvailableTo {
	case "moderators":
		return !isMod, true
	case "testers":
		if isMod {
			return false, true
		}
		if viewer == nil || viewer.ID == 0 {
			return true, true
		}
		return false, false
	case "members":
		return false, true
	case "nobody":
		return true, true
	}
	return false, true
}

// hiddenGateVersions is canGenerateBlockedTargets(applicableRulesFor(rules, user)) for the version
// ids canGenerate would otherwise answer true for (candidates): the ones a `hidden` rule that gates
// this viewer names. An ecosystem target on such a rule (`gate-rules-ecosystem`), and a `hidden`
// rule whose audience is not known here that names a candidate or any ecosystem
// (`gate-rules-testers`), fall back.
func hiddenGateVersions(rules []GateRule, viewer *Viewer, candidates map[int]bool) (map[int]bool, error) {
	blocked := map[int]bool{}
	for _, r := range rules {
		// experimental never gates; disabled keeps the version selectable (canGenerate stays true).
		if r.Presentation != "hidden" {
			continue
		}
		applies, known := gateApplies(r, viewer)
		if !known {
			if len(r.Ecosystems) > 0 {
				return nil, fallback.New("gate-rules-testers")
			}
			for _, id := range r.ModelVersionIDs {
				if candidates[id] {
					return nil, fallback.New("gate-rules-testers")
				}
			}
			continue
		}
		if !applies {
			continue
		}
		if len(r.Ecosystems) > 0 {
			return nil, fallback.New("gate-rules-ecosystem")
		}
		for _, id := range r.ModelVersionIDs {
			blocked[id] = true
		}
	}
	return blocked, nil
}
