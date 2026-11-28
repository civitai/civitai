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
	// ReasonTrackImpressionEventPoints: the impressions sink is on, but an impression names an
	// Image, Model or Article while a scored event's points window is open (eventPointsMayAward).
	// Node may then award view points for it (hattedImpressionEntities / awardViewPoints: Redis
	// dedupe and totals, a ClickHouse ledger row, a live push), which depends on the event's hat map
	// in Redis; this service does not reproduce that, so the whole batch stays on Node.
	ReasonTrackImpressionEventPoints = "track-impression-event-points"
	// ReasonTrackFeedSampleRate: the feed sink is on, but there is no current reading of the
	// `feed-events-sample-rate` Flipt variant, so whether Node would record the event is unknown.
	ReasonTrackFeedSampleRate = "track-feed-sample-rate"
	// ReasonTrackFeedSampled: the feed sink is on and a feed event's session is sampled, so Node
	// records a row for it. That row needs what this service does not have: the viewer's
	// personal-hot-lead cohort (a per-user Flipt evaluation), the build's page-route manifest
	// (pageRouteLabel) and the recorder's buffer. Only unsampled sessions, which record nothing, are
	// answered here.
	ReasonTrackFeedSampled = "track-feed-sampled"
)

// Sinks are the /api/track/batch sinks beyond the tracker service (whose search and action rows are
// always answered when the route is): Impressions (Tracker.impressions) and Feed (the feed events
// recorder, unsampled sessions only).
type Sinks struct {
	Impressions bool
	Feed        bool
}

// AllSinks is every ported sink (the shadow comparison computes with it).
var AllSinks = Sinks{Impressions: true, Feed: true}

// SinksLabel is the bounded `sinks` label of a batch this service answers: which optional sinks it
// used (one of SinkLabels).
func SinksLabel(s Sinks) string {
	switch {
	case s.Impressions && s.Feed:
		return "impressions-feed"
	case s.Impressions:
		return "impressions"
	case s.Feed:
		return "feed"
	}
	return "core"
}

// SinkLabels are SinksLabel's values: `core` is search and action rows only (step 1).
var SinkLabels = []string{"core", "impressions", "feed", "impressions-feed"}

// TrackBatch is src/pages/api/track/batch.ts for a batch of `search` and `action` events, plus, with
// their sinks on, `impression` events (outside every event-points window) and `feed` events of
// unsampled sessions. Every other event, and any event this service would reject, falls back with the
// whole request (see the reasons above), so no batch is ever split between the two writers.
func (e *Engine) TrackBatch(ctx context.Context, r *Request, sinks Sinks) (Outcome, error) {
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
	b, err := e.parseTrackEvents(parsed.A, sinks)
	if err != nil {
		return Outcome{}, err
	}
	out = Outcome{Response: end200(resp), Sinks: Sinks{Impressions: len(b.impressions) > 0, Feed: b.feed}}
	// No tracker: Tracker.send writes nothing (search and action rows go only through send).
	// Impressions do not go through send: Tracker.impressions inserts whenever the ClickHouse client
	// exists, which the impressions sink presumes (serve mode requires its configuration).
	tracked := e.TrackerEnabled && len(b.events) > 0
	if !tracked && len(b.impressions) == 0 {
		// Nothing to write (feed events here are unsampled: the recorder never reads the session for
		// them), so the session is never read either.
		return out, nil
	}
	ip, userAgent := "", "unknown"
	if tracked {
		if ip, err = resolveClientIP(r); err != nil {
			return Outcome{}, err
		}
		if ua, ok := r.Header("user-agent"); ok {
			userAgent = ua
		}
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
	writes := make([]Write, 0, len(b.events)+len(b.impressions))
	if !tracked {
		b.events = nil
	}
	for _, ev := range b.events {
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
	// Tracker.impressions: one insert per event, every row of it stamped with the viewer's id only.
	for i, imp := range b.impressions {
		for _, row := range imp.rows(userID) {
			writes = append(writes, Write{Table: TableImpressions, Body: row, Sink: SinkClickHouse, Insert: i})
		}
	}
	out.Writes = writes
	return out, nil
}

// trackBatch is a batch this service can answer: its tracker events, its impressions, and whether it
// carried a feed event (every one of them unsampled).
type trackBatch struct {
	events      []trackEvent
	impressions []impressionEvent
	feed        bool
}

// trackEvent is one accepted event: its table, the custom part of its row (the Tracker method's
// object, keys in its order) and whether the row carries the actor's ip and user agent.
type trackEvent struct {
	table         string
	custom        *jsvalue.Object
	skipActorMeta bool
}

// parseTrackEvents is parseTrackBatch's per-event parse (trackBatchEventSchema, a discriminated union
// on `kind`) for the kinds this service answers. Any other element is a fallback; when several are,
// the reason is the first of: an impression with its sink off, a feed event with its sink off, an
// impression an event-points window may award for, no sample-rate reading, a sampled feed session,
// an unported action type, an invalid event. So with the sinks off the impression and feed rates
// read as the share of batches carrying one, as they did before those sinks existed.
func (e *Engine) parseTrackEvents(items []jsvalue.Value, sinks Sinks) (trackBatch, error) {
	b := trackBatch{events: make([]trackEvent, 0, len(items))}
	var impressionOff, feedOff, points, unported, invalid bool
	var feedKeys []string
	for _, item := range items {
		kind, data, ok := eventParts(item)
		if !ok {
			invalid = true
			continue
		}
		switch kind {
		case "impression":
			if !sinks.Impressions {
				impressionOff = true
				continue
			}
			ev, ok := parseImpressionEvent(data)
			if !ok {
				invalid = true
				continue
			}
			points = points || ev.pointEligible
			b.impressions = append(b.impressions, ev)
		case "feed":
			if !sinks.Feed {
				feedOff = true
				continue
			}
			key, ok := parseFeedEvent(data)
			if !ok {
				invalid = true
				continue
			}
			feedKeys = append(feedKeys, key)
		case "search":
			ev, ok := parseSearchEvent(data)
			if !ok {
				invalid = true
				continue
			}
			b.events = append(b.events, ev)
		case "action":
			ev, res := parseActionEvent(data)
			switch res {
			case armOK:
				b.events = append(b.events, ev)
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
	case impressionOff:
		return trackBatch{}, fallback.New(ReasonTrackImpression)
	case feedOff:
		return trackBatch{}, fallback.New(ReasonTrackFeed)
	case points && eventPointsMayAward(e.now()):
		return trackBatch{}, fallback.New(ReasonTrackImpressionEventPoints)
	}
	if len(feedKeys) > 0 {
		// Read only when a feed event is present: a batch without one never depends on the dial.
		rate, ok := 0.0, false
		if e.FeedSampleRate != nil {
			rate, ok = e.FeedSampleRate()
		}
		if !ok {
			return trackBatch{}, fallback.New(ReasonTrackFeedSampleRate)
		}
		for _, key := range feedKeys {
			if feedSessionKept(key, rate) {
				return trackBatch{}, fallback.New(ReasonTrackFeedSampled)
			}
		}
		b.feed = true
	}
	switch {
	case unported:
		return trackBatch{}, fallback.New(ReasonTrackActionUnported)
	case invalid:
		return trackBatch{}, fallback.New(ReasonTrackEventInvalid)
	}
	return b, nil
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
