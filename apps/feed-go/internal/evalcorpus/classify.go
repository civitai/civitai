package evalcorpus

import (
	"bytes"
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/inputschema"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// The value classes (DESIGN.md §19.2). A key's class is decided by the first rule that names it:
// the endpoint's own (endpointRules.special), then the shared ones below, then the value's JSON
// type. Only the keys a request sends appear in its shape; an explicit null is "null".

// rules is one endpoint's input rules.
type rules struct {
	// schema is the inputschema name whose keys are the endpoint's known keys ("" for REST).
	schema string
	// rest is a REST endpoint: its input is the path and query string.
	rest bool
	// listCount are keys whose list value is read as a count, overriding literalLists.
	listCount map[string]bool
	// cursor classifies the `cursor` value.
	cursor func(v any) string
	// extra adds the endpoint's derived dimensions ("$"-prefixed keys) from the decoded input.
	extra func(m map[string]any, shape map[string]any)
}

// trpcTransportKeys are the keys the site's tRPC client adds to every input and zod strips
// (feed.trpcTransportKeys): known, so not `unknown:`, and classified by the shared rules.
var trpcTransportKeys = map[string]bool{"authed": true, "direction": true}

var endpointRules = map[string]rules{
	EndpointAsPosts:  {schema: inputschema.InfiniteImages, cursor: imageCursorClass, extra: imageExtras},
	EndpointInfinite: {schema: inputschema.InfiniteImages, cursor: imageCursorClass, extra: imageExtras},
	EndpointModelGetAll: {
		schema: inputschema.AllModels, cursor: modelCursorClass, extra: modelExtras,
		listCount: map[string]bool{"types": true, "baseModels": true},
	},
	EndpointV1ModelsID: {rest: true},
}

// literalStrings are enum keys whose string value is kept as written (enumLiteral bounds it).
var literalStrings = map[string]bool{
	"sort": true, "period": true, "periodMode": true, "checkpointType": true, "status": true,
	"availability": true, "hatSort": true, "direction": true,
}

// literalLists are enum-list keys whose value is kept as its sorted members.
var literalLists = map[string]bool{
	"types": true, "include": true, "reactions": true, "collectionItemStatus": true,
}

// bitmaskKeys are browsing-level bitmasks, kept literal.
var bitmaskKeys = map[string]bool{"browsingLevel": true, "preCapBrowsingLevel": true}

// limitLiterals are the `limit` values kept literal; any other is bucketed (limitClass).
var limitLiterals = map[int64]bool{
	0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true, 8: true, 9: true, 10: true,
	12: true, 15: true, 20: true, 24: true, 25: true, 30: true, 40: true, 50: true, 60: true, 80: true,
	100: true, 200: true,
}

// userIDKeys name the viewer's user id when equal to it; usernameKeys their username;
// collectionKeys one of their collections.
var (
	userIDKeys     = map[string]bool{"userId": true}
	usernameKeys   = map[string]bool{"username": true, "user": true}
	collectionKeys = map[string]bool{"collectionId": true}
)

var (
	enumLiteralRE = regexp.MustCompile(`^[A-Za-z0-9 _.:+-]{1,40}$`)
	keyNameRE     = regexp.MustCompile(`^[A-Za-z0-9_.\[\]-]{1,40}$`)
	digitsRE      = regexp.MustCompile(`^\d+$`)
	offsetRE      = regexp.MustCompile(`^\d{1,12}\|\d{1,15}$`)
	intTokenRE    = regexp.MustCompile(`^-?\d+$`)
)

// enumLiteral is s when it reads as an enum value, else "other" (a free-text value in an enum slot
// is never stored in a shape).
func enumLiteral(s string) string {
	if enumLiteralRE.MatchString(s) {
		return s
	}
	return "other"
}

// keyName is an unknown key's name as a shape records it: as sent when it reads as a key, else "?".
func keyName(k string) string {
	if keyNameRE.MatchString(k) {
		return k
	}
	return "?"
}

// intValue is v as an integer: a JSON number with no fraction, or a string of digits.
func intValue(v any) (int64, bool) {
	switch t := v.(type) {
	case json.Number:
		f, err := t.Float64()
		if err != nil || f != math.Trunc(f) || math.Abs(f) > 1<<53 {
			return 0, false
		}
		return int64(f), true
	case string:
		if !digitsRE.MatchString(t) || len(t) > 15 {
			return 0, false
		}
		n, err := strconv.ParseInt(t, 10, 64)
		return n, err == nil
	}
	return 0, false
}

// countClass is a list length's class.
func countClass(n int) string {
	switch n {
	case 0:
		return "0"
	case 1:
		return "1"
	}
	return "2+"
}

// listClass is a list's count class and the kind of its members: `int` (all positive integers),
// `num` (numbers, one not a positive integer), `str` (strings), `str-empty` (strings, one empty),
// `obj`, `mixed`. An empty list is "0".
func listClass(list []any) string {
	if len(list) == 0 {
		return "0"
	}
	kinds := map[string]bool{}
	for _, e := range list {
		switch t := e.(type) {
		case json.Number:
			if n, ok := intValue(t); ok && n > 0 {
				kinds["int"] = true
			} else {
				kinds["num"] = true
			}
		case string:
			if t == "" {
				kinds["str-empty"] = true
			} else {
				kinds["str"] = true
			}
		case map[string]any:
			kinds["obj"] = true
		default:
			kinds["mixed"] = true
		}
	}
	kind := "mixed"
	switch {
	case len(kinds) == 1:
		for k := range kinds {
			kind = k
		}
	case len(kinds) == 2 && kinds["int"] && kinds["num"]:
		kind = "num"
	case len(kinds) == 2 && kinds["str"] && kinds["str-empty"]:
		kind = "str-empty"
	}
	return countClass(len(list)) + ":" + kind
}

// literalList is an enum list's sorted members (each through enumLiteral; a non-string "?").
func literalList(list []any) string {
	out := make([]string, len(list))
	for i, e := range list {
		s, ok := e.(string)
		if !ok {
			out[i] = "?"
			continue
		}
		out[i] = enumLiteral(s)
	}
	sort.Strings(out)
	return "[" + strings.Join(out, ",") + "]"
}

// stringClass is a free string's class.
func stringClass(s string) string {
	switch {
	case s == "":
		return "empty"
	case strings.TrimSpace(s) == "":
		return "blank"
	case s == "true" || s == "false":
		return "str:" + s
	case digitsRE.MatchString(s):
		return "str:digits"
	}
	return "nonempty"
}

// idClass is an id-valued key's class: presence for a positive integer, and what else it is.
func idClass(v any) string {
	switch t := v.(type) {
	case json.Number:
		n, ok := intValue(t)
		switch {
		case !ok:
			return "id:nonint"
		case n == 0:
			return "id:zero"
		case n < 0:
			return "id:neg"
		}
		return "id"
	case string:
		if n, ok := intValue(t); ok && n > 0 {
			return "id:str"
		}
		return "id:" + stringClass(t)
	}
	return defaultClass(v)
}

// limitClass is `limit`'s class: literal in limitLiterals, else a bucket.
func limitClass(v any) string {
	n, ok := intValue(v)
	if _, isNum := v.(json.Number); !ok || !isNum {
		if s, isStr := v.(string); isStr {
			return stringClass(s)
		}
		return "invalid"
	}
	switch {
	case n < 0:
		return "invalid"
	case limitLiterals[n]:
		return strconv.FormatInt(n, 10)
	case n < 50:
		return "11-49"
	case n < 100:
		return "50-99"
	case n < 200:
		return "100-199"
	}
	return "200+"
}

// bitmaskClass is a browsing level's class: the integer, or "invalid".
func bitmaskClass(v any) string {
	n, ok := intValue(v)
	if _, isNum := v.(json.Number); !ok || !isNum || n < 0 || n > 1<<16 {
		return "invalid"
	}
	return strconv.FormatInt(n, 10)
}

// defaultClass is a value's class by its JSON type.
func defaultClass(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(t)
	case json.Number:
		if n, ok := intValue(t); ok && n == 0 {
			return "0"
		}
		return "num"
	case string:
		return stringClass(t)
	case []any:
		return listClass(t)
	case map[string]any:
		return "obj"
	}
	return "?"
}

// valueClass is key k's class under an endpoint's rules (cursor and the self keys aside).
func valueClass(r rules, k string, v any) string {
	if v == nil {
		return "null"
	}
	switch {
	case k == "limit":
		return limitClass(v)
	case bitmaskKeys[k]:
		return bitmaskClass(v)
	case k == "page":
		n, ok := intValue(v)
		switch {
		case !ok:
			return "invalid"
		case n == 1:
			return "1"
		case n >= 2:
			return "2+"
		}
		return "invalid"
	case literalStrings[k]:
		if s, ok := v.(string); ok {
			return enumLiteral(s)
		}
	case r.listCount[k]:
		if list, ok := v.([]any); ok {
			return listClass(list)
		}
	case literalLists[k]:
		if list, ok := v.([]any); ok {
			return literalList(list)
		}
	case strings.HasSuffix(k, "Id"):
		return idClass(v)
	}
	return defaultClass(v)
}

// imageCursorClass is an image endpoint's cursor class, read as its page sources read it: absent
// (a falsy value), the feed service's keyset (`feed:<a>:<b>`, feedsvc.ParseCursor), its offset with
// an entry instant (`<offset>|<entry>`), a collection Random cursor (`seed:sortKey:id`; a part that
// is not digits `random-bad`), a number or a string of digits (`numeric` / `numeric-str`), else
// `other`.
func imageCursorClass(v any) string {
	switch t := v.(type) {
	case nil:
		return "absent"
	case json.Number:
		if n, ok := intValue(t); ok && n == 0 {
			return "absent"
		}
		if n, ok := intValue(t); ok && n > 0 {
			return "numeric"
		}
		return "invalid"
	case string:
		switch {
		case t == "":
			return "absent"
		case feedsvc.ParseCursor(t) != "":
			return "feed"
		case offsetRE.MatchString(t):
			return "offset"
		case digitsRE.MatchString(t):
			return "numeric-str"
		}
		if parts := strings.Split(t, ":"); len(parts) == 3 {
			for _, p := range parts {
				if !digitsRE.MatchString(p) {
					return "random-bad"
				}
			}
			return "random-seed"
		}
		return "other"
	}
	return "invalid"
}

// modelCursorClass is model.getAll's cursor class: absent, `numeric` (a number: the keyset parser
// refuses it), or `entry:` and the kind of each `|`-separated token of a keyset entry (`t` a
// timestamp: a token with `-` that is not an integer; `n` an integer; `e` empty; `x` anything else),
// as modelfeed's parseCursor reads them. More than four tokens is `entry:many`.
func modelCursorClass(v any) string {
	switch t := v.(type) {
	case nil:
		return "absent"
	case json.Number:
		return "numeric"
	case string:
		if t == "" {
			return "absent"
		}
		toks := strings.Split(t, "|")
		if len(toks) > 4 {
			return "entry:many"
		}
		kinds := make([]string, len(toks))
		for i, tok := range toks {
			switch {
			case tok == "":
				kinds[i] = "e"
			case strings.Contains(tok, "-") && !intTokenRE.MatchString(tok):
				kinds[i] = "t"
			case intTokenRE.MatchString(tok):
				kinds[i] = "n"
			default:
				kinds[i] = "x"
			}
		}
		return "entry:" + strings.Join(kinds, "|")
	}
	return "invalid"
}

// imageExtras: `prioritizedUserIds` of exactly [-1] (the system user's showcase) is its own class.
func imageExtras(m map[string]any, shape map[string]any) {
	if list, ok := m["prioritizedUserIds"].([]any); ok && len(list) == 1 {
		if n, ok := intValue(list[0]); ok && n == -1 {
			shape["prioritizedUserIds"] = "[-1]"
		}
	}
}

// modelExtras: the paging mode (page and cursor), and whether the official-checkpoint pin applies
// (modelfeed.Serve: sort Hot with a base-model filter; it leads the first page, and every later page
// excludes the pinned ids).
func modelExtras(m map[string]any, shape map[string]any) {
	_, hasPage := m["page"]
	hasCursor := modelCursorClass(m["cursor"]) != "absent"
	switch {
	case hasPage && hasCursor:
		shape["$paging"] = "both"
	case hasPage:
		shape["$paging"] = "page"
	case hasCursor:
		shape["$paging"] = "cursor"
	default:
		shape["$paging"] = "none"
	}
	pin := "none"
	if s, _ := m["sort"].(string); s == "Hot" {
		if list, ok := m["baseModels"].([]any); ok && len(list) > 0 {
			pin = "first-page"
			if hasCursor {
				pin = "later-page"
			}
		}
	}
	shape["$pin"] = pin
	// The checkpointType filter (modelfeed's query): applied only when `types` is empty or names
	// Checkpoint, OR'ed with the other types when it names more. `types` itself is a count, so this
	// is what tells those paths apart.
	if ct, _ := m["checkpointType"].(string); ct != "" {
		list, _ := m["types"].([]any)
		hasCheckpoint, other := false, false
		for _, t := range list {
			if t == "Checkpoint" {
				hasCheckpoint = true
			} else {
				other = true
			}
		}
		switch {
		case len(list) == 0 || (hasCheckpoint && !other):
			shape["$checkpointFilter"] = "only"
		case hasCheckpoint:
			shape["$checkpointFilter"] = "mixed"
		default:
			shape["$checkpointFilter"] = "inert"
		}
	}
}

// trpcShape decodes a tRPC input and returns the input as stored and its shape. The stored input is
// the raw one unless it names the viewer or carries a credential-named key, when it is re-encoded
// with those values replaced or removed; an input that does not decode is not stored ("").
func trpcShape(raw string, self *selfMatcher, r rules) (stored string, shape map[string]any) {
	shape = map[string]any{}
	if raw == "" {
		shape["$envelope"] = "none"
		return "", shape
	}
	var env map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		shape["$envelope"] = "invalid"
		return "", shape
	}
	body, hasJSON := env["json"]
	var m map[string]any
	if hasJSON && string(bytes.TrimSpace(body)) != "null" {
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.UseNumber()
		if err := dec.Decode(&m); err != nil || m == nil {
			shape["$envelope"] = "invalid"
			return "", shape
		}
	}
	schema := inputschema.Get(r.schema)
	rewrite := map[string]any{} // key -> replacement (nil: remove)
	// Before any key is read as absent: a credential-named key goes from the stored input whatever
	// its meta says.
	for k := range m {
		if isCredentialName(k) {
			rewrite[k] = nil
		}
	}
	// Every key the stored input holds is checked for the viewer, an `undefined`-annotated one included
	// (it is still in the stored text).
	selfClass := map[string]string{}
	for _, k := range sortedKeys(m) {
		v := m[k]
		switch {
		case userIDKeys[k] && self.userID(v), usernameKeys[k] && self.username(v):
			selfClass[k] = SelfPlaceholder
			rewrite[k] = SelfPlaceholder
		case collectionKeys[k] && self.collection(v):
			selfClass[k] = SelfCollectionPlaceholder
			rewrite[k] = SelfCollectionPlaceholder
		}
		if strings.HasSuffix(k, "UserIds") {
			if list, ok := v.([]any); ok {
				if replaced, did := replaceSelfIDs(list, self); did {
					rewrite[k] = replaced
				}
			}
		}
	}
	annotations := metaAnnotations(env["meta"])
	for k, typ := range annotations {
		if typ == "undefined" {
			delete(m, k)
		}
	}
	for _, k := range sortedKeys(m) {
		v := m[k]
		name := k
		if !schema.Has(k) && !trpcTransportKeys[k] {
			name = "unknown:" + keyName(k)
		}
		// The self keys first: a value naming the viewer is replaced whatever else it is.
		switch {
		case selfClass[k] != "":
			shape[name] = selfClass[k]
		case annotations[k] != "":
			shape[name] = "meta:" + enumLiteral(annotations[k])
		case k == "cursor":
			shape[name] = r.cursor(v)
		default:
			shape[name] = valueClass(r, k, v)
		}
	}
	if r.extra != nil {
		r.extra(m, shape)
	}
	// Always re-encoded, never the raw text: a raw input can repeat a key (JSON.parse and Go both
	// keep the last), and an earlier copy naming the viewer would survive in the raw text.
	out, ok := rewriteEnvelope(env, rewrite)
	if !ok {
		return "", shape
	}
	return out, shape
}

// replaceSelfIDs is list with every member equal to the viewer's user id replaced by SelfPlaceholder.
func replaceSelfIDs(list []any, self *selfMatcher) ([]any, bool) {
	out := make([]any, len(list))
	replaced := false
	for i, e := range list {
		if self.userID(e) {
			out[i] = SelfPlaceholder
			replaced = true
			continue
		}
		out[i] = e
	}
	return out, replaced
}

// metaAnnotations is a superjson meta's annotation per top-level key: the type name of each `values`
// entry whose path is a top-level key. A nested path is ignored, as trpc.DecodeEnvelope ignores it
// (so a nested `undefined` never removes its parent key, and two nested paths cannot race for one
// key).
func metaAnnotations(raw json.RawMessage) map[string]string {
	out := map[string]string{}
	if len(raw) == 0 {
		return out
	}
	var meta struct {
		Values map[string]json.RawMessage `json:"values"`
	}
	if json.Unmarshal(raw, &meta) != nil {
		return out
	}
	for path, ann := range meta.Values {
		var typ []any
		if json.Unmarshal(ann, &typ) != nil || len(typ) == 0 {
			continue
		}
		name, _ := typ[0].(string)
		if strings.Contains(path, ".") {
			continue
		}
		out[path] = name
	}
	return out
}

// rewriteEnvelope re-encodes a superjson envelope with the json object's keys in rewrite replaced
// (nil: removed, with any meta annotation of theirs).
func rewriteEnvelope(env map[string]json.RawMessage, rewrite map[string]any) (string, bool) {
	var obj map[string]json.RawMessage
	if raw, ok := env["json"]; ok && json.Unmarshal(raw, &obj) != nil {
		return "", false
	}
	if obj == nil {
		obj = map[string]json.RawMessage{}
	}
	for k, v := range rewrite {
		if v == nil {
			delete(obj, k)
			continue
		}
		b, err := json.Marshal(v)
		if err != nil {
			return "", false
		}
		obj[k] = b
	}
	out := map[string]json.RawMessage{}
	for k, v := range env {
		out[k] = v
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return "", false
	}
	out["json"] = b
	if metaRaw, ok := env["meta"]; ok {
		var meta map[string]json.RawMessage
		if json.Unmarshal(metaRaw, &meta) == nil {
			var values map[string]json.RawMessage
			if json.Unmarshal(meta["values"], &values) == nil {
				for path := range values {
					key, _, _ := strings.Cut(path, ".")
					if v, ok := rewrite[key]; ok && v == nil {
						delete(values, path) // a removed key's annotations, nested ones included
					}
				}
				if vb, err := json.Marshal(values); err == nil {
					meta["values"] = vb
				}
				if mb, err := json.Marshal(meta); err == nil {
					out["meta"] = mb
				}
			}
		}
	}
	s, err := canonicalJSON(out)
	if err != nil {
		return "", false
	}
	return s, true
}

// v1ModelsPrefix is the `[id]` route's path prefix.
const v1ModelsPrefix = "/api/v1/models/"

// pathSegmentRE is a non-id path segment a Case may keep as written.
var pathSegmentRE = regexp.MustCompile(`^[A-Za-z0-9._-]{1,40}$`)

// restShape reads `GET /api/v1/models/[id]`: the id's class (`id`: what v1models.ParseID accepts;
// `invalid`; `absent`), the query as stored, the path as stored, and the query's shape: one `q:<key>`
// per query key (several values: `2+`; else the value's class), and `$credential-param` when a
// credential-named pair was there (it is not stored).
func restShape(path, rawQuery string, self *selfMatcher) (id, storedQuery, storedPath string, shape map[string]any) {
	shape = map[string]any{}
	seg, ok := strings.CutPrefix(path, v1ModelsPrefix)
	seg = strings.TrimSuffix(seg, "/")
	storedPath = path
	switch {
	case !ok || seg == "":
		id = "absent"
	default:
		if _, err := v1models.ParseID(seg); err == nil {
			id = "id"
		} else {
			id = "invalid"
			if !pathSegmentRE.MatchString(seg) || isCredentialName(seg) {
				storedPath = v1ModelsPrefix + "$invalid"
			}
		}
	}
	counts := map[string]int{}
	first := map[string]string{}
	selfKeys := map[string]bool{}
	for _, p := range splitQuery(rawQuery) {
		// The pairs stripQuery drops, so the shape describes the query as stored.
		if isCredentialName(p.key) || isCredentialName(lenientUnescape(p.raw)) {
			shape["$credential-param"] = "present"
			continue
		}
		counts[p.key]++
		if counts[p.key] == 1 {
			first[p.key] = p.value
		}
		if restSelfValue(p, self) {
			selfKeys[p.key] = true
		}
	}
	for k, n := range counts {
		name := "q:" + keyName(k)
		switch {
		case selfKeys[k]:
			shape[name] = SelfPlaceholder
		case n > 1:
			shape[name] = "2+"
		default:
			shape[name] = stringClass(first[k])
		}
	}
	storedQuery, _ = stripQuery(rawQuery)
	if self.matched {
		storedQuery = replaceSelfQuery(storedQuery, self)
	}
	return id, storedQuery, storedPath, shape
}

// restSelfValue reports whether one query pair names the viewer: a username key holding their
// username, or a user-id key holding their id.
func restSelfValue(p queryPair, self *selfMatcher) bool {
	return (usernameKeys[p.key] && self.username(p.value)) || (userIDKeys[p.key] && self.userID(p.value))
}

// replaceSelfQuery is a raw query with every pair naming the viewer (restSelfValue) set to
// SelfPlaceholder, each repetition of the key included.
func replaceSelfQuery(raw string, self *selfMatcher) string {
	pairs := splitQuery(raw)
	out := make([]string, len(pairs))
	for i, p := range pairs {
		if restSelfValue(p, self) {
			out[i] = url.QueryEscape(p.key) + "=" + url.QueryEscape(SelfPlaceholder)
			continue
		}
		out[i] = p.raw
	}
	return strings.Join(out, "&")
}
