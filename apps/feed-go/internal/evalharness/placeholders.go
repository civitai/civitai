package evalharness

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// Identity is what the placeholders of a stored case become: the replaying account's user id,
// username and collection, and a search text. Zero ids: signed out (a `$self` then cannot be replayed).
type Identity struct {
	UserID       int
	Username     string
	CollectionID int
	SearchText   string
}

// ErrPlaceholder is a placeholder the identity has nothing for (a `$self` signed out, a
// `$self-collection` for an account with no collection, a `$search` with no search text).
var ErrPlaceholder = errors.New("evalharness: placeholder with no value for this account")

// usernameKeys are the keys whose `$self` is the username (evalcorpus's usernameKeys); every other
// key's `$self` is the user id.
var usernameKeys = map[string]bool{"username": true, "user": true}

// placeholderValue is what a placeholder string under key becomes: a username or search text is a
// string; a user or collection id a JSON number, or its decimal string when bigint (the path is
// annotated ["bigint"], which superjson writes as a string). ok false: s is no placeholder.
func placeholderValue(s, key string, bigint bool, id Identity) (any, bool, error) {
	num := func(n int) (any, bool, error) {
		if n <= 0 {
			return nil, true, ErrPlaceholder
		}
		if bigint {
			return strconv.Itoa(n), true, nil
		}
		return json.Number(strconv.Itoa(n)), true, nil
	}
	switch s {
	case evalcorpus.SelfPlaceholder:
		if usernameKeys[key] {
			if id.Username == "" {
				return nil, true, ErrPlaceholder
			}
			return id.Username, true, nil
		}
		return num(id.UserID)
	case evalcorpus.SelfCollectionPlaceholder:
		return num(id.CollectionID)
	case evalcapture.SearchPlaceholder:
		if id.SearchText == "" {
			return nil, true, ErrPlaceholder
		}
		return id.SearchText, true, nil
	}
	return nil, false, nil
}

// isPlaceholder: s is one of the three placeholders.
func isPlaceholder(s string) bool {
	return s == evalcorpus.SelfPlaceholder || s == evalcorpus.SelfCollectionPlaceholder || s == evalcapture.SearchPlaceholder
}

// SubstituteInput is a stored tRPC input (the superjson envelope evalcorpus wrote) with every
// placeholder replaced by id's value, before anything decodes it (DESIGN.md §19.3: a placeholder
// under a bigint annotation is not a bigint). A string value equal to a placeholder is replaced at
// any depth; its key (an array member's: the array's key) picks username or id, and a ["bigint"]
// annotation at its exact path keeps an id a string. An input with no placeholder is returned as is.
func SubstituteInput(input string, id Identity) (string, error) {
	if !strings.Contains(input, "$") {
		return input, nil
	}
	var env map[string]json.RawMessage
	if err := json.Unmarshal([]byte(input), &env); err != nil {
		return "", errors.New("evalharness: stored input is not an envelope")
	}
	raw, ok := env["json"]
	if !ok {
		return input, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var body any
	if err := dec.Decode(&body); err != nil {
		return "", errors.New("evalharness: stored input's json does not decode")
	}
	ann := bigintPaths(env["meta"])
	changed := false
	out, err := substitute(body, "", nil, ann, id, &changed)
	if err != nil {
		return "", err
	}
	if !changed {
		return input, nil
	}
	b, err := marshalNoEscape(out)
	if err != nil {
		return "", err
	}
	env["json"] = b
	enc, err := marshalNoEscape(env)
	if err != nil {
		return "", err
	}
	return string(enc), nil
}

// substitute walks v, replacing placeholder strings; key is the nearest object key, path the
// superjson path of v.
func substitute(v any, key string, path []string, bigint map[string]bool, id Identity, changed *bool) (any, error) {
	switch t := v.(type) {
	case string:
		nv, ok, err := placeholderValue(t, key, bigint[superjsonPath(path)], id)
		if err != nil {
			return nil, err
		}
		if !ok {
			return t, nil
		}
		*changed = true
		return nv, nil
	case map[string]any:
		for k, e := range t {
			nv, err := substitute(e, k, append(append([]string(nil), path...), k), bigint, id, changed)
			if err != nil {
				return nil, err
			}
			t[k] = nv
		}
		return t, nil
	case []any:
		for i, e := range t {
			nv, err := substitute(e, key, append(append([]string(nil), path...), strconv.Itoa(i)), bigint, id, changed)
			if err != nil {
				return nil, err
			}
			t[i] = nv
		}
		return t, nil
	}
	return v, nil
}

// superjsonPath is superjson's escaped dotted path of segs (a `.` or `\` in a segment escaped with `\`).
func superjsonPath(segs []string) string {
	parts := make([]string, len(segs))
	for i, s := range segs {
		s = strings.ReplaceAll(s, `\`, `\\`)
		parts[i] = strings.ReplaceAll(s, ".", `\.`)
	}
	return strings.Join(parts, ".")
}

// bigintPaths is the set of meta.values paths annotated ["bigint"].
func bigintPaths(raw json.RawMessage) map[string]bool {
	out := map[string]bool{}
	if len(raw) == 0 {
		return out
	}
	var meta struct {
		Values map[string]json.RawMessage `json:"values"`
	}
	if json.Unmarshal(raw, &meta) != nil {
		return out
	}
	for p, a := range meta.Values {
		var typ []any
		if json.Unmarshal(a, &typ) == nil && len(typ) > 0 && typ[0] == "bigint" {
			out[p] = true
		}
	}
	return out
}

func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// SubstituteQuery is a stored REST query with every pair whose value is a placeholder set to id's
// value (a username key's `$self` the username, any other key's the user id), the other pairs kept
// as written.
func SubstituteQuery(raw string, id Identity) (string, error) {
	if !strings.Contains(raw, "$") && !strings.Contains(raw, "%24") {
		return raw, nil
	}
	parts := strings.Split(raw, "&")
	for i, p := range parts {
		k, v, _ := strings.Cut(p, "=")
		val, err := url.QueryUnescape(v)
		if err != nil || !isPlaceholder(val) {
			continue
		}
		key, err := url.QueryUnescape(k)
		if err != nil {
			key = k
		}
		nv, _, err := placeholderValue(val, key, true, id) // a query value is text: ids as decimal strings
		if err != nil {
			return "", err
		}
		s, _ := nv.(string) // always a string: bigint is true above
		parts[i] = k + "=" + url.QueryEscape(s)
	}
	return strings.Join(parts, "&"), nil
}
