// Package rest is the fallback read: the site's document-store list, `GET
// /api/v1/blocks/storage/<collection>?from=<slug>` (src/server/services/apps/doc-store-api.ts), made
// with the caller's own hub token, so the site judges it exactly as it judges the app calling it
// directly. Every read names its source app (`from`), as a registry read names it in its schema.
//
// DEPENDS ON A SITE CHANGE NOT IN THIS PR. Today the site refuses every `from` on a hub token
// (`import_hub_token` in doc-store-access.ts `resolveImportAccess`), so this fallback answers that
// refusal. A separate site PR lifts it: a hub token may then read another app's collection when the
// user granted the import, decided by `decideCollectionRead`, the predicate the adapter's private
// feed runs, and a `from` naming the token's own app reads that app's own storage. Until it merges,
// only the registry path serves data to a hub token.
package rest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// PageSize is the store's largest list page (doc-store.types.ts DOC_STORE_BOUNDS.listLimitMax).
const PageSize = 100

// MaxBody bounds one page's response: 100 documents of at most 64 KiB each, with room for the rest.
const MaxBody = 8 << 20

// Doc is a listed document, with only the fields this service passes on.
type Doc struct {
	Key     string          `json:"key"`
	Data    json.RawMessage `json:"data"`
	Version int64           `json:"version"`
}

// Error is the site's refusal, passed back to the caller as the site sent it. Status 0 is a
// transport failure or an unreadable answer.
type Error struct {
	Status int
	// Body is the site's error envelope, at most 64 KiB, or nil.
	Body []byte
}

func (e *Error) Error() string { return fmt.Sprintf("rest: status %d", e.Status) }

// ErrTooMany is a list longer than the caller's bound.
var ErrTooMany = errors.New("rest: the collection holds more documents than this service returns")

// Client reads the site's document store.
type Client struct {
	// BaseURL is the site's URL (config RESTURL).
	BaseURL string
	// HTTP is the client used; nil is http.DefaultClient. Requests are bounded by their context.
	HTTP *http.Client
	// MaxRecords bounds one read, as a stream's cache is bounded.
	MaxRecords int
}

// List reads every document of collection, in the app `from` names, that the token may read.
func (c *Client) List(ctx context.Context, token, collection, from string) ([]Doc, error) {
	var out []Doc
	cursor := ""
	for {
		page, next, err := c.page(ctx, token, collection, from, cursor)
		if err != nil {
			return nil, err
		}
		out = append(out, page...)
		if len(out) > c.MaxRecords {
			return nil, ErrTooMany
		}
		if next == "" {
			return out, nil
		}
		// A page that moves nothing would page forever.
		if len(page) == 0 || next == cursor {
			return nil, &Error{}
		}
		cursor = next
	}
}

func (c *Client) page(ctx context.Context, token, collection, from, cursor string) ([]Doc, string, error) {
	u, err := url.Parse(strings.TrimRight(c.BaseURL, "/"))
	if err != nil {
		return nil, "", &Error{}
	}
	u.Path += "/api/v1/blocks/storage/" + url.PathEscape(collection)
	q := url.Values{"limit": {strconv.Itoa(PageSize)}}
	if from != "" {
		q.Set("from", from)
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), http.NoBody)
	if err != nil {
		return nil, "", &Error{}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", &Error{}
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		if !json.Valid(body) {
			body = nil
		}
		return nil, "", &Error{Status: res.StatusCode, Body: body}
	}
	var p struct {
		Items      []Doc   `json:"items"`
		NextCursor *string `json:"nextCursor"`
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, MaxBody+1))
	if err != nil || len(raw) > MaxBody || json.Unmarshal(raw, &p) != nil || p.Items == nil {
		return nil, "", &Error{}
	}
	next := ""
	if p.NextCursor != nil {
		next = *p.NextCursor
	}
	return p.Items, next, nil
}
