package beacon

import (
	"context"
	"math"
	"regexp"

	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// The telemetry batch beacon, POST /api/track/batch (src/pages/api/track/batch.ts), and the tracker
// tables its search and action events write (Tracker.search / Tracker.action in
// src/server/clickhouse/tracker.ts).
const (
	EndpointTrackBatch = "track-batch"

	TableSearch  = "search"
	TableActions = "actions"
)

// TrackBatchMax is TRACK_BATCH_MAX (src/server/schema/track.schema.ts): the most events one batch
// carries.
const TrackBatchMax = 100

// TrackFreeformMaxChars is TRACK_FREEFORM_MAX_CHARS: the longest `filters` of a search event, in
// JSON characters.
const TrackFreeformMaxChars = 64 * 1024

// The fallback reasons of /api/track/batch, one per kind of event this service leaves to the Node app.
// Each is a whole-request fallback: the batch is proxied (serve) or counted (shadow) unchanged, so no
// event is ever split between the two writers.
const (
	// ReasonTrackImpression: an `impression` event. Tracker.impressions inserts into ClickHouse
	// directly (not through the tracker service), and the event can award hatted view points.
	ReasonTrackImpression = "track-impression"
	// ReasonTrackFeed: a `feed` event (the feed events recorder, which reads the viewer's session
	// tier and personal hot-lead state).
	ReasonTrackFeed = "track-feed"
	// ReasonTrackActionUnported: an action type whose schema depends on state not copied here
	// (Experiment_Exposure: the experiment registry and its variants).
	ReasonTrackActionUnported = "track-action-unported"
	// ReasonTrackEventInvalid: an event this service's copy of the schema does not accept. Node
	// drops such an event and keeps the rest; this service does not reproduce the drop, because a
	// value Node has started accepting since the copy was taken would be lost. Node decides.
	ReasonTrackEventInvalid = "track-event-invalid"
)

// TrackBatch is src/pages/api/track/batch.ts for a batch of `search` and `action` events. Every other
// event kind, and any event this service would reject, falls back with the whole request (see the
// reasons above).
func (e *Engine) TrackBatch(ctx context.Context, r *Request) (Outcome, error) {
	pb, resp, out, done, err := prologue(r)
	if done {
		return out, err
	}
	if res, err := checkSameOrigin(r, resp); err != nil || res != nil {
		return outcomeOf(res), err
	}
	parsed, res, err := beaconBody(pb, resp)
	if err != nil || res != nil {
		return outcomeOf(res), err
	}
	// parseTrackBatch's envelope: an array of 1..TRACK_BATCH_MAX elements, else 400 invalid input.
	if parsed.Kind != jsvalue.Array || len(parsed.A) == 0 || len(parsed.A) > TrackBatchMax {
		return Outcome{Response: send400(resp, "invalid input")}, nil
	}
	events, err := parseTrackEvents(parsed.A)
	if err != nil {
		return Outcome{}, err
	}
	// No tracker: Tracker.send writes nothing and never resolves the session (search and action rows
	// go only through send).
	if !e.TrackerEnabled {
		return Outcome{Response: end200(resp)}, nil
	}
	ip, err := resolveClientIP(r)
	if err != nil {
		return Outcome{}, err
	}
	// One Tracker for the whole batch: the session is resolved once, after the 200 (the handler awaits
	// none of the events), so no rolling refresh can reach this response, and none is attempted.
	user, err := e.Sessions.Resolve(ctx, r.HTTP)
	if err != nil {
		return Outcome{}, err
	}
	userID := 0.0
	if user != nil {
		userID = float64(user.ID)
	}
	userAgent := "unknown"
	if ua, ok := r.Header("user-agent"); ok {
		userAgent = ua
	}
	writes := make([]Write, 0, len(events))
	for _, ev := range events {
		// track(): `{...actorMeta, ...custom}`, actorMeta `{userId}` alone under skipActorMeta.
		row := jsvalue.NewObject()
		row.Set("userId", jsvalue.NumberValue(userID))
		if !ev.skipActorMeta {
			row.Set("ip", jsvalue.StringValue(ip))
			row.Set("userAgent", jsvalue.StringValue(userAgent))
		}
		for _, k := range ev.custom.Keys() {
			v, _ := ev.custom.Get(k)
			row.Set(k, v)
		}
		writes = append(writes, Write{Table: ev.table, Body: jsvalue.Stringify(jsvalue.ObjectValue(row))})
	}
	return Outcome{Response: end200(resp), Writes: writes}, nil
}

// trackEvent is one accepted event: its table, the custom part of its row (the Tracker method's
// object, keys in its order) and whether the row carries the actor's ip and user agent.
type trackEvent struct {
	table         string
	custom        *jsvalue.Object
	skipActorMeta bool
}

// parseTrackEvents is parseTrackBatch's per-event parse (trackBatchEventSchema, a discriminated union
// on `kind`) for the kinds this service writes. Any other element is a fallback; when several are,
// the reason is the first of impression, feed, an unported action type, an invalid event, so the
// impression and feed rates read as the share of batches carrying one.
func parseTrackEvents(items []jsvalue.Value) ([]trackEvent, error) {
	out := make([]trackEvent, 0, len(items))
	var impression, feed, unported, invalid bool
	for _, item := range items {
		kind, data, ok := eventParts(item)
		if !ok {
			invalid = true
			continue
		}
		switch kind {
		case "impression":
			impression = true
		case "feed":
			feed = true
		case "search":
			ev, ok := parseSearchEvent(data)
			if !ok {
				invalid = true
				continue
			}
			out = append(out, ev)
		case "action":
			ev, res := parseActionEvent(data)
			switch res {
			case armOK:
				out = append(out, ev)
			case armUnported:
				unported = true
			default:
				invalid = true
			}
		default:
			invalid = true
		}
	}
	switch {
	case impression:
		return nil, fallback.New(ReasonTrackImpression)
	case feed:
		return nil, fallback.New(ReasonTrackFeed)
	case unported:
		return nil, fallback.New(ReasonTrackActionUnported)
	case invalid:
		return nil, fallback.New(ReasonTrackEventInvalid)
	}
	return out, nil
}

// eventParts reads `{kind, data}`: an object whose `kind` is a string. `data` is returned as found
// (each arm checks it is an object).
func eventParts(v jsvalue.Value) (string, jsvalue.Value, bool) {
	if !v.IsPlainObject() {
		return "", jsvalue.Value{}, false
	}
	k, ok := v.O.Get("kind")
	if !ok || k.Kind != jsvalue.String {
		return "", jsvalue.Value{}, false
	}
	d, ok := v.O.Get("data")
	if !ok {
		return "", jsvalue.Value{}, false
	}
	return k.S, d, true
}

// parseSearchEvent is trackSearchSchema (`query` a string, trimmed; `index` a string; `filters` an
// optional passthrough object whose JSON is at most TRACK_FREEFORM_MAX_CHARS) and Tracker.search's
// object: `{...rest, filters}`, filters JSON.stringify'd, or ” when absent.
func parseSearchEvent(data jsvalue.Value) (trackEvent, bool) {
	if !data.IsPlainObject() {
		return trackEvent{}, false
	}
	q, ok := data.O.Get("query")
	if !ok || q.Kind != jsvalue.String {
		return trackEvent{}, false
	}
	idx, ok := data.O.Get("index")
	if !ok || idx.Kind != jsvalue.String {
		return trackEvent{}, false
	}
	filters := ""
	if f, ok := data.O.Get("filters"); ok {
		fv, ok := passthroughObject(f, nil)
		if !ok || !withinJSONLimit(fv, TrackFreeformMaxChars) {
			return trackEvent{}, false
		}
		filters = string(jsvalue.Stringify(fv))
	}
	custom := jsvalue.NewObject()
	custom.Set("query", jsvalue.StringValue(jsvalue.Trim(q.S)))
	custom.Set("index", idx)
	custom.Set("filters", jsvalue.StringValue(filters))
	return trackEvent{table: TableSearch, custom: custom}, true
}

// armResult is how an action event parsed.
type armResult uint8

const (
	armOK armResult = iota
	armInvalid
	armUnported
)

// parseActionEvent is trackActionSchema (a discriminated union on `type`) and Tracker.action's
// object: `{...rest, details}` (rest is the arm's output without `details`), details
// JSON.stringify'd, or ” when absent, and the actor's ip and user agent left out for the
// ACTOR_META_FREE_ACTION_TYPES.
func parseActionEvent(data jsvalue.Value) (trackEvent, armResult) {
	if !data.IsPlainObject() {
		return trackEvent{}, armInvalid
	}
	t, ok := data.O.Get("type")
	if !ok || t.Kind != jsvalue.String {
		return trackEvent{}, armInvalid
	}
	arm, ok := actionArms[t.S]
	if !ok {
		return trackEvent{}, armInvalid
	}
	if arm.unported {
		return trackEvent{}, armUnported
	}
	custom := jsvalue.NewObject()
	custom.Set("type", t)
	for _, f := range arm.top {
		v, present, ok := f.parse(data.O)
		if !ok {
			return trackEvent{}, armInvalid
		}
		if present {
			custom.Set(f.name, v)
		}
	}
	details := ""
	dv, has := data.O.Get("details")
	switch {
	case arm.details == nil:
		// The arm has no `details` key: whatever the client sent is stripped.
	case !has:
		if !arm.detailsOptional {
			return trackEvent{}, armInvalid
		}
	default:
		obj, ok := arm.details.parse(dv)
		if !ok {
			return trackEvent{}, armInvalid
		}
		details = string(jsvalue.Stringify(obj))
	}
	custom.Set("details", jsvalue.StringValue(details))
	return trackEvent{table: TableActions, custom: custom, skipActorMeta: arm.skipActorMeta}, armOK
}

// passthroughObject is zod's object with a passthrough catchall (`.passthrough()`, `z.looseObject`):
// a plain object, the shape's keys parsed first in shape order, then every other own key as it came
// in, except a `__proto__` key (zod's catchall skips it).
func passthroughObject(v jsvalue.Value, shape []field) (jsvalue.Value, bool) {
	spec := objectSpec{fields: shape, passthrough: true}
	return spec.parse(v)
}

// withinJSONLimit is measureJsonLength([v], max) !== 'over' for a JSON-parsed value (see
// withinDetailsLimit).
func withinJSONLimit(v jsvalue.Value, limit int) bool {
	if jsvalue.CountNodes(v) > limit/2 {
		return false
	}
	return jsvalue.UTF16Len(string(jsvalue.Stringify(v))) <= limit
}

// ---- A small zod: the shapes the action arms use --------------------------------------------------

type fieldKind uint8

const (
	kindNumber      fieldKind = iota // z.number(): a finite number
	kindInt                          // z.number().int(): a safe integer
	kindString                       // z.string()
	kindBool                         // z.boolean()
	kindEnum                         // z.enum([...])
	kindStringArray                  // z.array(z.string())
)

// maxSafeInteger is Number.MAX_SAFE_INTEGER, zod 4's `.int()` bound.
const maxSafeInteger = 1<<53 - 1

// field is one key of a zod object shape.
type field struct {
	name     string
	kind     fieldKind
	optional bool // `.optional()` (or `.nullish()`): the key may be absent
	nullable bool // `.nullable()` (or `.nullish()`): the value may be null
	enum     map[string]bool
	trim     bool           // `.trim()`, applied before maxLen
	maxLen   int            // `.max(n)` on a string, in UTF-16 units; 0 = none
	re       *regexp.Regexp // `.regex(re)`
	positive bool           // `.positive()`
	min, max *float64       // `.min(n)` / `.max(n)` on a number, inclusive
}

// parse reads the field from an object: its output value, whether the key is in the output, and
// whether it is valid.
func (f field) parse(o *jsvalue.Object) (jsvalue.Value, bool, bool) {
	v, ok := o.Get(f.name)
	if !ok {
		return jsvalue.Value{}, false, f.optional
	}
	if v.Kind == jsvalue.Null {
		return v, true, f.nullable
	}
	switch f.kind {
	case kindNumber, kindInt:
		if !isFiniteNumber(v) {
			return v, true, false
		}
		if f.kind == kindInt && (math.Trunc(v.N) != v.N || math.Abs(v.N) > maxSafeInteger) {
			return v, true, false
		}
		if (f.positive && v.N <= 0) || (f.min != nil && v.N < *f.min) || (f.max != nil && v.N > *f.max) {
			return v, true, false
		}
		return v, true, true
	case kindBool:
		return v, true, v.Kind == jsvalue.Bool
	case kindEnum:
		return v, true, isEnum(v, f.enum)
	case kindStringArray:
		if v.Kind != jsvalue.Array {
			return v, true, false
		}
		for _, e := range v.A {
			if e.Kind != jsvalue.String {
				return v, true, false
			}
		}
		return v, true, true
	}
	// kindString
	if v.Kind != jsvalue.String {
		return v, true, false
	}
	s := v.S
	if f.trim {
		s = jsvalue.Trim(s)
	}
	if f.maxLen > 0 && jsvalue.UTF16Len(s) > f.maxLen {
		return v, true, false
	}
	if f.re != nil && !f.re.MatchString(s) {
		return v, true, false
	}
	return jsvalue.StringValue(s), true, true
}

// objectSpec is a zod object: its shape, and whether unknown keys are kept (passthrough) or stripped.
type objectSpec struct {
	fields      []field
	passthrough bool
}

func (s objectSpec) parse(v jsvalue.Value) (jsvalue.Value, bool) {
	if !v.IsPlainObject() {
		return jsvalue.Value{}, false
	}
	out := jsvalue.NewObject()
	known := make(map[string]bool, len(s.fields))
	for _, f := range s.fields {
		known[f.name] = true
		val, present, ok := f.parse(v.O)
		if !ok {
			return jsvalue.Value{}, false
		}
		if present {
			out.Set(f.name, val)
		}
	}
	if s.passthrough {
		for _, k := range v.O.Keys() {
			if known[k] || k == "__proto__" {
				continue
			}
			val, _ := v.O.Get(k)
			out.Set(k, val)
		}
	}
	return jsvalue.ObjectValue(out), true
}

// actionArm is one arm of trackActionSchema.
type actionArm struct {
	// top are the arm's keys besides `type` and `details` (LoginRedirect's `reason`).
	top []field
	// details is the arm's `details` object; nil when the arm has no `details` key.
	details         *objectSpec
	detailsOptional bool
	// skipActorMeta: the type is in tracker.ts ACTOR_META_FREE_ACTION_TYPES.
	skipActorMeta bool
	// unported: the arm is not reproduced; an event of this type falls back.
	unported bool
}
