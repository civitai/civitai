// Package trpc speaks the slice of the tRPC v11 HTTP protocol one non-batched query needs, as the main
// app's pages-router adapter serves it (`GET /api/trpc/<path>?input=<superjson envelope>`).
//
//	success: {"result":{"data":<superjson envelope>}}
//	error:   {"error":{"json":{"message":…,"code":-32xxx,"data":{"code":"BAD_REQUEST","httpStatus":400,"path":…}}}}
//
// Batched requests (`?batch=1`, or a path naming several procedures) are refused: the procedure this
// service serves is never batched by the web client (NEVER_BATCH_PROCEDURES in src/utils/trpc.ts).
package trpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// ErrBatched is returned for a batched request.
var ErrBatched = errors.New("batched tRPC requests are not served here")

// ParseInput returns the decoded `json` part of a superjson-encoded `input` query parameter, with the
// meta annotations this procedure's inputs can carry applied: a `bigint` becomes its decimal string,
// a `Date` stays its ISO string, an `undefined` is removed. A devalue-encoded (string) input is refused —
// the web client writes superjson inputs (clientTransformer in src/shared/utils/trpc-union-transformer.ts).
func ParseInput(r *http.Request) (map[string]any, error) {
	q := r.URL.Query()
	if q.Get("batch") != "" {
		return nil, ErrBatched
	}
	raw := q.Get("input")
	if raw == "" {
		return map[string]any{}, nil
	}
	return DecodeEnvelope([]byte(raw))
}

// DecodeEnvelope decodes a superjson `{json, meta}` input envelope into a plain map.
func DecodeEnvelope(raw []byte) (map[string]any, error) {
	var env struct {
		JSON json.RawMessage `json:"json"`
		Meta *struct {
			Values map[string]json.RawMessage `json:"values"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("input is not a superjson envelope: %w", err)
	}
	out := map[string]any{}
	if len(env.JSON) > 0 && string(env.JSON) != "null" {
		dec := json.NewDecoder(bytes.NewReader(env.JSON))
		dec.UseNumber()
		if err := dec.Decode(&out); err != nil {
			return nil, fmt.Errorf("input json is not an object: %w", err)
		}
	}
	if env.Meta != nil {
		for path, ann := range env.Meta.Values {
			var typ []any
			if json.Unmarshal(ann, &typ) != nil || len(typ) == 0 {
				continue
			}
			name, _ := typ[0].(string)
			// Only top-level keys are meaningful for this procedure's flat input.
			switch name {
			case "undefined":
				delete(out, path)
			case "bigint", "Date":
				// Already a string in `json`; parsed by the consumer.
			default:
				return nil, fmt.Errorf("unsupported superjson annotation %q at %q", name, path)
			}
		}
	}
	return out, nil
}

// Error is a tRPC error response.
type Error struct {
	Code       string // TRPC_ERROR_CODE_KEY, e.g. BAD_REQUEST
	HTTPStatus int
	Message    string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// jsonRPCCode maps the tRPC error key to its JSON-RPC number (TRPC_ERROR_CODES_BY_KEY).
var jsonRPCCode = map[string]int{
	"PARSE_ERROR":           -32700,
	"BAD_REQUEST":           -32600,
	"INTERNAL_SERVER_ERROR": -32603,
	"UNAUTHORIZED":          -32001,
	"FORBIDDEN":             -32003,
	"NOT_FOUND":             -32004,
	"METHOD_NOT_SUPPORTED":  -32005,
	"TOO_MANY_REQUESTS":     -32029,
}

// WriteError writes a tRPC error envelope (superjson-wrapped, as the app's error formatter output is).
func WriteError(w http.ResponseWriter, path string, e *Error) {
	body := superjson.Object{
		{Key: "message", Val: e.Message},
		{Key: "code", Val: jsonRPCCode[e.Code]},
		{Key: "data", Val: superjson.Object{
			{Key: "code", Val: e.Code},
			{Key: "httpStatus", Val: e.HTTPStatus},
			{Key: "path", Val: path},
		}},
	}
	enc, err := superjson.Serialize(body)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(e.HTTPStatus)
	_, _ = w.Write([]byte(`{"error":`))
	_, _ = w.Write(enc)
	_, _ = w.Write([]byte(`}`))
}

// CacheTTL is the edge-cache policy createContext gives a request: cacheable (60/60/30) only when signed out.
type CacheTTL struct {
	Browser, Edge, StaleWhileRevalidate int
}

// SignedOutTTL is createContext's cacheable policy.
var SignedOutTTL = CacheTTL{Browser: 60, Edge: 60, StaleWhileRevalidate: 30}

// WriteResult writes a success envelope around an already-serialized superjson payload.
func WriteResult(w http.ResponseWriter, payload []byte, ttl *CacheTTL) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	if ttl != nil && ttl.Edge > 0 {
		// edge-cache-headers.ts: `public, max-age=<browser>, s-maxage=<edge>, stale-while-revalidate=<swr>`.
		h.Set("Cache-Control", "public, max-age="+strconv.Itoa(ttl.Browser)+", s-maxage="+strconv.Itoa(ttl.Edge)+
			", stale-while-revalidate="+strconv.Itoa(ttl.StaleWhileRevalidate))
	} else {
		h.Set("Cache-Control", "max-age=0, private, no-cache")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"result":{"data":`))
	_, _ = w.Write(payload)
	_, _ = w.Write([]byte(`}}`))
}
