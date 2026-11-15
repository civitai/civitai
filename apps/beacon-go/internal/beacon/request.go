package beacon

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// Request is a beacon request as the Node handler sees it: `req.headers` (lowercase names, each value
// one JS string), whether `req.url` carries a query, the socket peer, and the body before Next's body
// parser ran (or, in shadow mode, after Node decoded it).
type Request struct {
	Method string
	// HasQuery: the request target carried a query string. getServerAuthSession and
	// requestCarriesCallerCredentials both read `?token=` from it; a beacon never sends one, so any
	// query falls back rather than reproducing Next's query parsing.
	HasQuery bool
	// Headers are Node's `req.headers`: lowercase names, a repeated header already folded the way
	// Node folds it (NodeHeaders), values as JS strings (each header byte one character).
	Headers map[string]string
	// Body is the raw request body (serve mode). When BodyDecoded is set, Body is instead the JS
	// string Next's raw-body step produced (charset-decoded, BOM stripped), as the shadow sampler
	// forwards it.
	Body        []byte
	BodyDecoded bool
	// BodyIsString (with BodyDecoded) is whether Next left `req.body` a string. For a JSON body the
	// forwarded Body is then the string itself rather than JSON to parse; for the other kinds it is a
	// check of this service's content-type parse against Next's.
	BodyIsString bool
	// HTTP is the request the session resolver reads (Authorization, `?token=`, Cookie).
	HTTP *http.Request
}

// Header returns a header and whether it was sent (an empty value is sent).
func (r *Request) Header(name string) (string, bool) {
	v, ok := r.Headers[name]
	return v, ok
}

// discardDuplicates are the headers whose repeats Node's HTTP parser drops, keeping the first
// (IncomingMessage#_addHeaderLine: `matchKnownFields`).
var discardDuplicates = map[string]bool{
	"age": true, "authorization": true, "content-length": true, "content-type": true, "etag": true,
	"expires": true, "from": true, "host": true, "if-modified-since": true, "if-unmodified-since": true,
	"last-modified": true, "location": true, "max-forwards": true, "proxy-authorization": true,
	"referer": true, "retry-after": true, "server": true, "user-agent": true,
}

// NodeHeaders builds `req.headers` from a Go request: lowercase names; a repeated header kept first
// (discardDuplicates), joined with "; " (cookie) or ", " (everything else); each byte one character
// (Latin1). Host comes from r.Host (net/http moves it out of the header map).
func NodeHeaders(r *http.Request) map[string]string {
	out := make(map[string]string, len(r.Header)+1)
	for name, vals := range r.Header {
		if len(vals) == 0 {
			continue
		}
		lower := strings.ToLower(name)
		var v string
		switch {
		case discardDuplicates[lower]:
			v = vals[0]
		case lower == "cookie":
			v = strings.Join(vals, "; ")
		default:
			v = strings.Join(vals, ", ")
		}
		out[lower] = jsvalue.Latin1(v)
	}
	if r.Host != "" {
		out["host"] = jsvalue.Latin1(r.Host)
	}
	return out
}

// FromHTTP is the beacon request for a Go request and its body (read whole).
func FromHTTP(r *http.Request, body []byte) *Request {
	return &Request{
		Method:   r.Method,
		HasQuery: r.URL.RawQuery != "" || r.URL.ForceQuery || strings.Contains(r.RequestURI, "?"),
		Headers:  NodeHeaders(r),
		Body:     body,
		HTTP:     r,
	}
}

// bodyKind is what Next's parseBody turns the body into.
type bodyKind uint8

const (
	bodyText bodyKind = iota // the decoded string
	bodyJSON                 // JSON.parse of it ({} when empty)
)

// content-type's parse() (next/dist/compiled/content-type), whose failure parseBody answers with
// `text/plain`.
var (
	ctType  = regexp.MustCompile(`^[!#$%&'*+.^_` + "`" + `|~0-9A-Za-z-]+/[!#$%&'*+.^_` + "`" + `|~0-9A-Za-z-]+$`)
	ctParam = regexp.MustCompile(`^; *([!#$%&'*+.^_` + "`" + `|~0-9A-Za-z-]+) *= *("(?:[\x{000b}\x{0020}\x{0021}\x{0023}-\x{005b}\x{005d}-\x{007e}\x{0080}-\x{00ff}]|\\[\x{000b}\x{0020}-\x{00ff}])*"|[!#$%&'*+.^_` + "`" + `|~0-9A-Za-z-]+) *`)
	ctQesc  = regexp.MustCompile(`\\([\x{000b}\x{0020}-\x{00ff}])`)
)

// parseContentType is content-type's parse(header || 'text/plain'), falling back to text/plain on a
// throw, as parseBody does: the lowercased type and the parameters (names lowercased, later wins).
func parseContentType(header string) (string, map[string]string) {
	if header == "" {
		header = "text/plain"
	}
	t, params, ok := parseContentTypeStrict(header)
	if !ok {
		return "text/plain", map[string]string{}
	}
	return t, params
}

func parseContentTypeStrict(header string) (string, map[string]string, bool) {
	index := strings.IndexByte(header, ';')
	var typ string
	if index != -1 {
		typ = jsvalue.Trim(header[:index])
	} else {
		typ = jsvalue.Trim(header)
	}
	if !ctType.MatchString(typ) {
		return "", nil, false
	}
	params := map[string]string{}
	if index != -1 {
		for index < len(header) {
			m := ctParam.FindStringSubmatch(header[index:])
			if m == nil {
				break
			}
			index += len(m[0])
			key := strings.ToLower(m[1])
			value := m[2]
			if value != "" && value[0] == '"' {
				value = value[1 : len(value)-1]
				value = ctQesc.ReplaceAllString(value, "$1")
			}
			params[key] = value
		}
		if index != len(header) {
			return "", nil, false
		}
	}
	return strings.ToLower(typ), params, true
}

// iconvName is iconv-lite's codec-name normalisation: lowercased, a `:NNNN` suffix and every
// character other than [0-9a-z] removed.
func iconvName(enc string) string {
	enc = strings.ToLower(enc)
	if i := strings.LastIndexByte(enc, ':'); i >= 0 && len(enc)-i == 5 && isDigits(enc[i+1:]) {
		enc = enc[:i]
	}
	var b strings.Builder
	for i := 0; i < len(enc); i++ {
		c := enc[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') {
			b.WriteByte(c)
		}
	}
	return b.String()
}

func isDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}

// MaxBody is Next's default API body limit, '1mb' (bytes.parse: 1024 * 1024).
const MaxBody = 1 << 20

// parsedBody is `req.body` after Next's parseBody.
type parsedBody struct {
	kind bodyKind
	text string        // bodyText: the string
	json jsvalue.Value // bodyJSON: the parsed value
}

// nextError is a response Next's apiResolver writes itself when parseBody throws an ApiError
// (sendError): the handler never runs, so none of PublicEndpoint's headers are set.
type nextError struct {
	status int
	body   string
}

// parseBody is Next 16's parseBody (next/dist/server/api-utils/node/parse-body.js) for a body already
// read whole: decode per the charset (only UTF-8 is reproduced), strip a leading BOM (iconv-lite's
// StripBOM), then JSON / urlencoded / text by the media type.
func parseBody(r *Request) (parsedBody, *nextError, error) {
	ctHeader, _ := r.Header("content-type")
	typ, params := parseContentType(ctHeader)
	if r.BodyDecoded {
		pb, err := decodedBody(r, typ)
		return pb, nil, err
	}
	if len(r.Body) > MaxBody {
		return parsedBody{}, nil, fallback.New("body-too-large")
	}
	if cs := params["charset"]; cs != "" && iconvName(cs) != "utf8" {
		return parsedBody{}, nil, fallback.New("charset")
	}
	text := strings.TrimPrefix(jsvalue.DecodeUTF8(r.Body), "\ufeff")
	switch typ {
	case "application/json", "application/ld+json":
		if text == "" {
			return parsedBody{kind: bodyJSON, json: jsvalue.ObjectValue(jsvalue.NewObject())}, nil, nil
		}
		v, err := jsvalue.Parse(text)
		if errors.Is(err, jsvalue.ErrTooDeep) {
			return parsedBody{}, nil, fallback.New("json-depth")
		}
		if err != nil {
			return parsedBody{}, &nextError{status: 400, body: "Invalid JSON"}, nil
		}
		return parsedBody{kind: bodyJSON, json: v}, nil, nil
	case "application/x-www-form-urlencoded":
		// Next decodes it to an object of strings, which both handlers refuse; beacons never send one.
		return parsedBody{}, nil, fallback.New("form-body")
	}
	return parsedBody{kind: bodyText, text: text}, nil, nil
}

// decodedBody is parseBody for a shadow sample, whose body Node already parsed: the kind comes from
// this service's own reading of the Content-Type, and a body whose form disagrees with it (a string
// where an object was expected, or the reverse) is a divergence in that reading, not a beacon.
func decodedBody(r *Request, typ string) (parsedBody, error) {
	text := string(r.Body)
	switch typ {
	case "application/json", "application/ld+json":
		if r.BodyIsString {
			return parsedBody{kind: bodyJSON, json: jsvalue.StringValue(text)}, nil
		}
		v, err := jsvalue.Parse(text)
		if err != nil {
			return parsedBody{}, fallback.New("shadow-body-kind")
		}
		return parsedBody{kind: bodyJSON, json: v}, nil
	case "application/x-www-form-urlencoded":
		return parsedBody{}, fallback.New("form-body")
	}
	if !r.BodyIsString {
		return parsedBody{}, fallback.New("shadow-body-kind")
	}
	return parsedBody{kind: bodyText, text: text}, nil
}
