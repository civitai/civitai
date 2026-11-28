package beacon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/civitai/civitai/apps/beacon-go/internal/auth"
	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
)

// countingUser is a SessionResolver that counts its calls.
type countingUser struct {
	u     *auth.SessionUser
	err   error
	calls *atomic.Int32
}

func (c countingUser) Resolve(context.Context, *http.Request) (*auth.SessionUser, error) {
	c.calls.Add(1)
	return c.u, c.err
}

const drop = "\x00drop"

// batchReq is a /api/track/batch request as the browser sends it; extra overrides a header (drop
// removes it).
func batchReq(body string, extra map[string]string) *Request {
	h := map[string]string{
		"host": "a.test", "origin": "https://a.test", "content-type": "application/json",
		"user-agent": "ua", "cf-connecting-ip": "192.0.2.1",
	}
	for k, v := range extra {
		if v == drop {
			delete(h, k)
			continue
		}
		h[k] = v
	}
	return &Request{
		Method:  http.MethodPost,
		Headers: h,
		Body:    []byte(body),
		HTTP:    httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/track/batch", nil),
	}
}

type wantWrite struct{ table, body string }

// The rows, written by hand from tracker.ts track() ({...actorMeta, ...custom}), Tracker.search
// ({...rest, filters}) and Tracker.action ({...rest, details}), and the schemas' shape order, not
// from the generator.
func TestTrackBatchRowsLiteral(t *testing.T) {
	const actor = `"userId":0,"ip":"192.0.2.1","userAgent":"ua"`
	cases := []struct {
		name string
		user *auth.SessionUser
		body string
		want []wantWrite
	}{
		{
			name: "search, query trimmed, filters stringified, unknown key stripped",
			body: `[{"kind":"search","data":{"x":1,"filters":{"b":2,"0":true},"index":"models_v9","query":" cat "}}]`,
			want: []wantWrite{{"search", `{` + actor + `,"query":"cat","index":"models_v9","filters":"{\"0\":true,\"b\":2}"}`}},
		},
		{
			name: "search without filters writes an empty string",
			body: `[{"kind":"search","data":{"query":"q","index":"i"}}]`,
			want: []wantWrite{{"search", `{` + actor + `,"query":"q","index":"i","filters":""}`}},
		},
		{
			name: "signed in: the session's id, for every row",
			user: &auth.SessionUser{ID: 42},
			body: `[{"kind":"search","data":{"query":"q","index":"i"}},{"kind":"action","data":{"type":"AwardBounty_Click"}}]`,
			want: []wantWrite{
				{"search", `{"userId":42,"ip":"192.0.2.1","userAgent":"ua","query":"q","index":"i","filters":""}`},
				{"actions", `{"userId":42,"ip":"192.0.2.1","userAgent":"ua","type":"AwardBounty_Click","details":""}`},
			},
		},
		{
			name: "action with details, shape order, unknown detail stripped",
			body: `[{"kind":"action","data":{"details":{"amount":5,"extra":1,"toUserId":3},"type":"NotEnoughFunds"}}]`,
			want: []wantWrite{{"actions", `{` + actor + `,"type":"NotEnoughFunds","details":"{\"amount\":5}"}`}},
		},
		{
			name: "LoginRedirect: its reason is a column, its details are stripped",
			body: `[{"kind":"action","data":{"reason":"train-model","type":"LoginRedirect","details":{"a":1}}}]`,
			want: []wantWrite{{"actions", `{` + actor + `,"type":"LoginRedirect","reason":"train-model","details":""}`}},
		},
		{
			name: "passthrough details keep unknown keys after the shape, integer keys first",
			body: `[{"kind":"action","data":{"type":"Membership_Downgrade","details":{"z":1,"7":"x","reason":"r"}}}]`,
			want: []wantWrite{{"actions", `{` + actor + `,"type":"Membership_Downgrade","details":"{\"7\":\"x\",\"reason\":\"r\",\"z\":1}"}`}},
		},
		{
			name: "an actor-meta-free type writes the user id only",
			user: &auth.SessionUser{ID: 9},
			body: `[{"kind":"action","data":{"type":"App_Error","details":{"stage":"submit","reason":"other","appBlockId":"apb_1"}}}]`,
			want: []wantWrite{{"actions", `{"userId":9,"type":"App_Error","details":"{\"appBlockId\":\"apb_1\",\"reason\":\"other\",\"stage\":\"submit\"}"}`}},
		},
		{
			name: "rows in array order",
			body: `[{"kind":"action","data":{"type":"AddToBounty_Click"}},{"kind":"search","data":{"query":"a","index":"i"}},{"kind":"action","data":{"type":"AwardBounty_Confirm"}}]`,
			want: []wantWrite{
				{"actions", `{` + actor + `,"type":"AddToBounty_Click","details":""}`},
				{"search", `{` + actor + `,"query":"a","index":"i","filters":""}`},
				{"actions", `{` + actor + `,"type":"AwardBounty_Confirm","details":""}`},
			},
		},
		{
			name: "Feed_TagBar_Click: tag trimmed, null kept",
			body: `[{"kind":"action","data":{"type":"Feed_TagBar_Click","details":{"action":"select","tagId":null,"tag":" Anime ","feed":"images"}}}]`,
			want: []wantWrite{{"actions", `{` + actor + `,"type":"Feed_TagBar_Click","details":"{\"feed\":\"images\",\"tag\":\"Anime\",\"tagId\":null,\"action\":\"select\"}"}`}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := &Engine{Sessions: fixedUser{u: c.user}, TrackerEnabled: true}
			out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(c.body, nil))
			if err != nil {
				t.Fatal(err)
			}
			if out.Response.Status != 200 || out.Response.Body != "" {
				t.Fatalf("response %+v", out.Response)
			}
			if _, ok := out.Response.Get("etag"); ok {
				t.Fatal("a 200 carries no ETag")
			}
			if len(out.Writes) != len(c.want) {
				t.Fatalf("%d writes, want %d: %+v", len(out.Writes), len(c.want), out.Writes)
			}
			for i, w := range out.Writes {
				if w.Table != c.want[i].table || string(w.Body) != c.want[i].body {
					t.Errorf("write %d\n got  %s %s\n want %s %s", i, w.Table, w.Body, c.want[i].table, c.want[i].body)
				}
			}
		})
	}
}

// Every 400 the handler gives, with Next's ETag for its body; none resolves the session or writes.
func TestTrackBatch400s(t *testing.T) {
	overMax := "[" + strings.TrimSuffix(strings.Repeat(`{"kind":"action","data":{"type":"AwardBounty_Click"}},`, 101), ",") + "]"
	cases := []struct {
		name, body string
		headers    map[string]string
		wantBody   string
		wantETag   string
	}{
		{"no origin or referer", `[]`, map[string]string{"origin": drop}, "invalid request", `"weftv9g98bf"`},
		{"cross-origin", `[]`, map[string]string{"origin": "https://b.test"}, "invalid request", `"weftv9g98bf"`},
		{"an empty Origin wins over the Referer", `[]`, map[string]string{"origin": "", "referer": "https://a.test/x"}, "invalid request", `"weftv9g98bf"`},
		{"unparseable origin", `[]`, map[string]string{"origin": "nope"}, "invalid request", `"weftv9g98bf"`},
		{"text body that is not JSON", `[{"kind":`, map[string]string{"content-type": drop}, "invalid body", `"eueval305xc"`},
		{"an object, not an array", `{"kind":"search","data":{"query":"q","index":"i"}}`, nil, "invalid input", `"17fa7f31cyhd"`},
		{"an empty array", `[]`, nil, "invalid input", `"17fa7f31cyhd"`},
		{"null", `null`, nil, "invalid input", `"17fa7f31cyhd"`},
		{"an empty JSON body is {}", ``, nil, "invalid input", `"17fa7f31cyhd"`},
		{"TRACK_BATCH_MAX + 1 events", overMax, nil, "invalid input", `"17fa7f31cyhd"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			calls := &atomic.Int32{}
			e := &Engine{Sessions: countingUser{calls: calls}, TrackerEnabled: true}
			out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(c.body, c.headers))
			if err != nil {
				t.Fatal(err)
			}
			if out.Response.Status != 400 || out.Response.Body != c.wantBody {
				t.Fatalf("got %d %q, want 400 %q", out.Response.Status, out.Response.Body, c.wantBody)
			}
			if etag, _ := out.Response.Get("etag"); etag != c.wantETag {
				t.Fatalf("etag %q, want %q", etag, c.wantETag)
			}
			if len(out.Writes) != 0 || calls.Load() != 0 {
				t.Fatalf("a 400 wrote %d rows / resolved the session %d times", len(out.Writes), calls.Load())
			}
		})
	}
}

// TRACK_BATCH_MAX events are one batch: 100 rows.
func TestTrackBatchAtTheMax(t *testing.T) {
	body := "[" + strings.TrimSuffix(strings.Repeat(`{"kind":"action","data":{"type":"AwardBounty_Click"}},`, 100), ",") + "]"
	e := &Engine{Sessions: fixedUser{}, TrackerEnabled: true}
	out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(body, nil))
	if err != nil {
		t.Fatal(err)
	}
	if out.Response.Status != 200 || len(out.Writes) != 100 {
		t.Fatalf("status %d, %d writes", out.Response.Status, len(out.Writes))
	}
	const row = `{"userId":0,"ip":"192.0.2.1","userAgent":"ua","type":"AwardBounty_Click","details":""}`
	if string(out.Writes[99].Body) != row || out.Writes[99].Table != "actions" {
		t.Fatalf("last row %s %s", out.Writes[99].Table, out.Writes[99].Body)
	}
}

// Every batch this service does not answer whole falls back with the whole request, before the
// session is read and without a row: Node writes all of it or none of it is written here.
func TestTrackBatchFallsBackWhole(t *testing.T) {
	const ok = `{"kind":"search","data":{"query":"q","index":"i"}}`
	const imp = `{"kind":"impression","data":{"sessionKey":"k","surface":"images","entities":[{"entityType":"Image","entityId":1}]}}`
	const feed = `{"kind":"feed","data":{"event":"load","sessionKey":"k","feed":"images","page":"/images"}}`
	const exp = `{"kind":"action","data":{"type":"Experiment_Exposure","details":{"exp":"x","variant":"a","assignment":"rule","surface":"feed-card"}}}`
	const bad = `{"kind":"action","data":{"type":"Tip_Click","details":{"toUserId":"three"}}}`
	cases := []struct{ name, body, reason string }{
		{"an impression", "[" + imp + "]", "track-impression"},
		{"an impression among searches", "[" + ok + "," + imp + "," + ok + "]", "track-impression"},
		{"a feed event", "[" + feed + "," + ok + "]", "track-feed"},
		{"impression outranks feed", "[" + feed + "," + imp + "]", "track-impression"},
		{"feed outranks unported", "[" + exp + "," + feed + "]", "track-feed"},
		{"an unported action type", "[" + ok + "," + exp + "]", "track-action-unported"},
		{"unported outranks invalid", "[" + bad + "," + exp + "]", "track-action-unported"},
		{"a malformed event Node would drop", "[" + ok + "," + bad + "]", "track-event-invalid"},
		{"an unknown kind", `[{"kind":"future","data":{}},` + ok + "]", "track-event-invalid"},
		{"a kind that is not a string", `[{"kind":1,"data":{}}]`, "track-event-invalid"},
		{"no data", `[{"kind":"search"}]`, "track-event-invalid"},
		{"an element that is not an object", `[1]`, "track-event-invalid"},
		{"search data not an object", `[{"kind":"search","data":[]}]`, "track-event-invalid"},
		{"search query not a string", `[{"kind":"search","data":{"query":1,"index":"i"}}]`, "track-event-invalid"},
		{"search index missing", `[{"kind":"search","data":{"query":"q"}}]`, "track-event-invalid"},
		{"search filters null", `[{"kind":"search","data":{"query":"q","index":"i","filters":null}}]`, "track-event-invalid"},
		{"search filters an array", `[{"kind":"search","data":{"query":"q","index":"i","filters":[]}}]`, "track-event-invalid"},
		{"search filters past TRACK_FREEFORM_MAX_CHARS", `[{"kind":"search","data":{"query":"q","index":"i","filters":{"a":"` + strings.Repeat("x", 64*1024) + `"}}}]`, "track-event-invalid"},
		{"action data not an object", `[{"kind":"action","data":"x"}]`, "track-event-invalid"},
		{"action type missing", `[{"kind":"action","data":{}}]`, "track-event-invalid"},
		{"a server-only action type", `[{"kind":"action","data":{"type":"App_Open"}}]`, "track-event-invalid"},
		{"required details missing", `[{"kind":"action","data":{"type":"Generator_Submit"}}]`, "track-event-invalid"},
		{"details not an object", `[{"kind":"action","data":{"type":"Tip_Click","details":"x"}}]`, "track-event-invalid"},
		{"LoginRedirect without its reason", `[{"kind":"action","data":{"type":"LoginRedirect"}}]`, "track-event-invalid"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			calls := &atomic.Int32{}
			e := &Engine{Sessions: countingUser{calls: calls}, TrackerEnabled: true}
			out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(c.body, nil))
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("reason %q (err %v), want %q", got, err, c.reason)
			}
			if len(out.Writes) != 0 || calls.Load() != 0 {
				t.Fatalf("a fallback wrote %d rows / resolved the session %d times", len(out.Writes), calls.Load())
			}
		})
	}
}

// Without a tracker nothing is written and the session is never read; impressions and feed events
// still fall back (Node writes those through other sinks).
func TestTrackBatchTrackerDisabled(t *testing.T) {
	calls := &atomic.Int32{}
	e := &Engine{Sessions: countingUser{calls: calls}, TrackerEnabled: false}
	out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(`[{"kind":"search","data":{"query":"q","index":"i"}}]`, nil))
	if err != nil || out.Response.Status != 200 || len(out.Writes) != 0 || calls.Load() != 0 {
		t.Fatalf("err %v, status %d, %d writes, %d session reads", err, out.Response.Status, len(out.Writes), calls.Load())
	}
	_, err = e.Compute(context.Background(), EndpointTrackBatch, batchReq(`[{"kind":"feed","data":{}}]`, nil))
	if fallback.Reason(err) != "track-feed" {
		t.Fatalf("feed without a tracker: %v", err)
	}
}

// The actor: the user agent defaults to 'unknown'; an ip only the socket could give, an API-key
// session and a query string fall back as on the other beacons.
func TestTrackBatchActor(t *testing.T) {
	e := &Engine{Sessions: fixedUser{}, TrackerEnabled: true}
	body := `[{"kind":"search","data":{"query":"q","index":"i"}}]`
	out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(body, map[string]string{"user-agent": drop}))
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"userId":0,"ip":"192.0.2.1","userAgent":"unknown","query":"q","index":"i","filters":""}`
	if len(out.Writes) != 1 || string(out.Writes[0].Body) != want {
		t.Fatalf("writes %+v", out.Writes)
	}
	if _, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(body, map[string]string{"cf-connecting-ip": drop})); fallback.Reason(err) != "client-ip-socket" {
		t.Fatalf("no ip header: %v", err)
	}
	se := &Engine{Sessions: fixedUser{err: fallback.New("bearer-token")}, TrackerEnabled: true}
	if _, err := se.Compute(context.Background(), EndpointTrackBatch, batchReq(body, nil)); fallback.Reason(err) != "bearer-token" {
		t.Fatalf("session fallback: %v", err)
	}
	q := batchReq(body, nil)
	q.HasQuery = true
	if _, err := e.Compute(context.Background(), EndpointTrackBatch, q); fallback.Reason(err) != "query-string" {
		t.Fatalf("query: %v", err)
	}
	if _, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(body, map[string]string{"origin": "https://a.test\\x"})); fallback.Reason(err) != "url" {
		t.Fatalf("an origin outside the reproduced URL subset: %v", err)
	}
}

// Each zod shape the arms use, accepted and refused at its boundary. A refusal is a fallback of the
// whole batch (Node's answer then stands), so these pin what is answered here, not what Node drops.
func TestActionArmFields(t *testing.T) {
	cases := []struct {
		name    string
		data    string
		details string // the stringified details when accepted; "-" when refused
	}{
		{"number", `{"type":"NotEnoughFunds","details":{"amount":-1.5}}`, `{"amount":-1.5}`},
		{"number overflow is Infinity", `{"type":"NotEnoughFunds","details":{"amount":1e400}}`, "-"},
		{"number as a string", `{"type":"NotEnoughFunds","details":{"amount":"1"}}`, "-"},
		{"required number missing", `{"type":"NotEnoughFunds","details":{}}`, "-"},
		{"optional details absent", `{"type":"NotEnoughFunds"}`, ``},
		{"int at MAX_SAFE_INTEGER", `{"type":"Announcement_Click","details":{"announcementId":9007199254740991,"creatorId":1}}`, `{"announcementId":9007199254740991,"creatorId":1}`},
		{"int past MAX_SAFE_INTEGER", `{"type":"Announcement_Click","details":{"announcementId":9007199254740992,"creatorId":1}}`, "-"},
		{"int with a fraction", `{"type":"Announcement_Click","details":{"announcementId":1.5,"creatorId":1}}`, "-"},
		{"positive int at 0", `{"type":"Announcement_Click","details":{"announcementId":0,"creatorId":1}}`, "-"},
		{"int range at max", `{"type":"App_Session","details":{"appBlockId":"a","host":"page","durationMs":86400000,"submits":0,"messagesToHost":0}}`, `{"appBlockId":"a","host":"page","durationMs":86400000,"submits":0,"messagesToHost":0}`},
		{"int range past max", `{"type":"App_Session","details":{"appBlockId":"a","host":"page","durationMs":86400001,"submits":0,"messagesToHost":0}}`, "-"},
		{"int range below min", `{"type":"App_Session","details":{"appBlockId":"a","host":"page","durationMs":1,"submits":-1,"messagesToHost":0}}`, "-"},
		{"string pattern", `{"type":"App_Error","details":{"appBlockId":"apb-1","reason":"other","stage":"submit"}}`, "-"},
		{"string pattern, 64 characters", `{"type":"App_Error","details":{"appBlockId":"` + strings.Repeat("a", 64) + `","reason":"other","stage":"submit"}}`, `{"appBlockId":"` + strings.Repeat("a", 64) + `","reason":"other","stage":"submit"}`},
		{"string pattern, 65 characters", `{"type":"App_Error","details":{"appBlockId":"` + strings.Repeat("a", 65) + `","reason":"other","stage":"submit"}}`, "-"},
		{"string not a string", `{"type":"Tip_Confirm","details":{"toUserId":1,"amount":1,"entityType":5}}`, "-"},
		{"nullish string null", `{"type":"Tip_Confirm","details":{"toUserId":1,"amount":1,"entityType":null}}`, `{"toUserId":1,"entityType":null,"amount":1}`},
		{"null where only optional", `{"type":"Model_Create_Click","details":{"source":null}}`, "-"},
		{"null where required", `{"type":"TipInteractive_Click","details":{"toUserId":null,"entityId":1,"entityType":"x","amount":1}}`, "-"},
		{"max length after trim, 64", `{"type":"Feed_TagBar_Click","details":{"feed":"images","tag":"  ` + strings.Repeat("t", 64) + `  ","tagId":1,"action":"select"}}`, `{"feed":"images","tag":"` + strings.Repeat("t", 64) + `","tagId":1,"action":"select"}`},
		{"max length counts UTF-16 units", `{"type":"Feed_TagBar_Click","details":{"feed":"images","tag":"` + strings.Repeat("😀", 33) + `","tagId":1,"action":"select"}}`, "-"},
		{"max length 128 with a pattern", `{"type":"Generator_Submit","details":{"fromAction":"create","externalId":"` + strings.Repeat("x", 129) + `"}}`, "-"},
		{"pattern refuses a space", `{"type":"Generator_Submit","details":{"fromAction":"create","externalId":"a b"}}`, "-"},
		{"pattern refuses a trailing newline", `{"type":"Generator_Submit","details":{"fromAction":"create","externalId":"ab\n"}}`, "-"},
		{"enum", `{"type":"AppsBuild_Action","details":{"action":"view","state":"nope"}}`, "-"},
		{"enum not a string", `{"type":"AppsBuild_Action","details":{"action":"view","state":1}}`, "-"},
		{"boolean", `{"type":"UserMenu_Click","details":{"item":"vault","group":"help","pinned":"yes","surface":"mobile"}}`, "-"},
		{"nullable enum with the header group", `{"type":"UserMenu_Click","details":{"item":"vault","group":"header","pinned":true,"surface":"mobile"}}`, `{"item":"vault","group":"header","pinned":true,"surface":"mobile"}`},
		{"string array", `{"type":"ProfanitySearch","details":{"matches":["a",1]}}`, "-"},
		{"string array not an array", `{"type":"ProfanitySearch","details":{"matches":"a"}}`, "-"},
		{"loose object drops __proto__", `{"type":"CSAM_Help_Triggered","details":{"__proto__":{"a":1},"query":"q","k":[]}}`, `{"query":"q","k":[]}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := &Engine{Sessions: fixedUser{}, TrackerEnabled: true}
			out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(`[{"kind":"action","data":`+c.data+`}]`, nil))
			if c.details == "-" {
				if fallback.Reason(err) != ReasonTrackEventInvalid {
					t.Fatalf("accepted (%v): %+v", err, out.Writes)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var row map[string]any
			if err := json.Unmarshal(out.Writes[0].Body, &row); err != nil {
				t.Fatal(err)
			}
			if row["details"] != c.details {
				t.Fatalf("details %q, want %q", row["details"], c.details)
			}
		})
	}
}

// trackBatchVectors is vectors.json's `trackBatch`, written by gen.ts from the Node constants.
type trackBatchVectors struct {
	TrackBatchMax    int                 `json:"trackBatchMax"`
	FreeformMaxChars int                 `json:"freeformMaxChars"`
	ActionTypes      []string            `json:"actionTypes"`
	ActorMetaFree    []string            `json:"actorMetaFree"`
	Enums            map[string][]string `json:"enums"`
	Patterns         map[string]string   `json:"patterns"`
	Numbers          map[string]float64  `json:"numbers"`
}

// The copies in trackbatch_arms.go equal the Node values gen.ts recorded (and
// beacon-go-track-batch-vectors.test.ts pins the recording against the live Node constants).
func TestTrackBatchConstants(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "golden", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		TrackBatch trackBatchVectors `json:"trackBatch"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatal(err)
	}
	v := file.TrackBatch
	if v.TrackBatchMax != TrackBatchMax || v.FreeformMaxChars != TrackFreeformMaxChars {
		t.Errorf("TRACK_BATCH_MAX %d / TRACK_FREEFORM_MAX_CHARS %d, Node %d / %d", TrackBatchMax, TrackFreeformMaxChars, v.TrackBatchMax, v.FreeformMaxChars)
	}
	types := make([]string, 0, len(actionArms))
	var metaFree []string
	for name, arm := range actionArms {
		types = append(types, name)
		if arm.skipActorMeta {
			metaFree = append(metaFree, name)
		}
	}
	sort.Strings(types)
	sort.Strings(metaFree)
	// Positive control: the recording is not empty.
	if len(v.ActionTypes) < 25 || len(v.Enums) < 18 {
		t.Fatalf("vectors.json trackBatch looks empty: %d types, %d enums", len(v.ActionTypes), len(v.Enums))
	}
	if !reflect.DeepEqual(types, v.ActionTypes) {
		t.Errorf("action arms\n here %v\n Node %v", types, v.ActionTypes)
	}
	if !reflect.DeepEqual(metaFree, v.ActorMetaFree) {
		t.Errorf("actor-meta-free types\n here %v\n Node %v", metaFree, v.ActorMetaFree)
	}
	copies := map[string][]string{
		"trackedReasons":             trackedReasons,
		"userMenuItemIds":            userMenuItemIDs,
		"userMenuGroupIds":           userMenuGroupIDs,
		"userMenuHeaderGroup":        {userMenuHeaderGroup},
		"pushPromptActions":          pushPromptActions,
		"pushPromptSurfaces":         pushPromptSurfaces,
		"pushPromptVariants":         pushPromptVariants,
		"experimentSurfaces":         experimentSurfaces,
		"hatTurfClientActions":       hatTurfClientActions,
		"hatTurfEvents":              hatTurfEvents,
		"appStoreActions":            appStoreActions,
		"appStoreQueryLengthBuckets": appStoreQueryLengthBucket,
		"appSurfaces":                appSurfaces,
		"listingSorts":               listingSorts,
		"marketplaceCategories":      marketplaceCategories,
		"appSubmitFailureReasons":    appSubmitFailureReasons,
		"appErrorStages":             appErrorStages,
		"appSessionHosts":            appSessionHosts,
	}
	if len(copies) != len(v.Enums) {
		t.Errorf("%d copies, Node recorded %d enums", len(copies), len(v.Enums))
	}
	for name, node := range v.Enums {
		if !reflect.DeepEqual(copies[name], node) {
			t.Errorf("%s\n here %v\n Node %v", name, copies[name], node)
		}
	}
	if v.Patterns["appStoreListingId"] != appStoreListingIDPattern || v.Patterns["appBlockId"] != appBlockIDPattern {
		t.Errorf("patterns here %q %q, Node %v", appStoreListingIDPattern, appBlockIDPattern, v.Patterns)
	}
	if v.Numbers["appStorePositionMax"] != appStorePositionMax || v.Numbers["appSessionMaxDurationMs"] != appSessionMaxDurationMs ||
		v.Numbers["appSessionMaxCount"] != appSessionMaxCount {
		t.Errorf("numbers here %v %v %v, Node %v", appStorePositionMax, appSessionMaxDurationMs, appSessionMaxCount, v.Numbers)
	}
}
