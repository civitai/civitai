package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/shared"
)

// SHARED COLLECTIONS (APP_DATA_WRITES on; package shared). A read of a collection the private feed
// does not serve (the private stream's Live is another feed's, session.ErrNotPrivate), or of any
// collection by a signed-out viewer, is answered from the shared collection's level streams and the
// viewer's per-viewer stream, never from REST:
//
//	GET …/records[?keyPrefix=P][&author=me][&sort=key|-key][&limit=N][&cursor=C][&major=N][&minSeq=S]
//	→ {"source":"registry","items":[doc…],"nextCursor":C|null}
//	GET …/records/{key}           → {"source":"registry","item":doc}
//	GET …/records/@me             the viewer's document of a `keyedBy: viewer` collection
//	GET …/records/@me/{parent}    the viewer's document for parent, `keyedBy: parent+viewer`
//
// where doc is {"urn","key","rev","data","version","createdAt","updatedAt","author":{"isViewer"}}.
// `limit` is 1 to 100 (default 25) and the cursor is the store's own key-sort cursor (`ka~~<key>`,
// `kd~~<key>`), so a page boundary reads as it does on REST. The rest of REST's list (`where[…]`, the
// other sorts) is not served from the streams: `400 not_supported_here`. An answer that needs what
// lies below a truncated level stream's window is `503 too_large`.

// SharedReads answers shared reads (shared.Reader).
type SharedReads interface {
	Read(ctx context.Context, v shared.Viewer, slug, collection string, major int, minSeq int64) (shared.Board, error)
}

// The store's list bounds (doc-store.types.ts DOC_STORE_BOUNDS listLimitDefault, listLimitMax).
const (
	listLimitDefault = 25
	listLimitMax     = 100
)

// sharedSchemas remembers, per collection schema, that its private stream named another feed: the
// collection is shared, whoever reads it, so later reads go straight to the shared path. A
// collection's visibility can change only with a new approved version, so the memo is kept for
// sharedMemoTTL.
type sharedSchemas struct {
	mu    sync.Mutex
	until map[string]time.Time
}

const sharedMemoTTL = 15 * time.Minute

func (m *sharedSchemas) known(schema string, now time.Time) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	until, ok := m.until[schema]
	return ok && now.Before(until)
}

func (m *sharedSchemas) mark(schema string, now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.until == nil {
		m.until = map[string]time.Time{}
	}
	for k, u := range m.until {
		if !now.Before(u) {
			delete(m.until, k)
		}
	}
	m.until[schema] = now.Add(sharedMemoTTL)
}

// sharedPath reports whether a read goes to the shared path before any private stream is tried: a
// signed-out viewer's token, or a schema known to be shared.
func (s *Server) sharedPath(p readParams) bool {
	return s.Shared != nil && (anonymousShape(p.token) || s.shared.known(p.schema, time.Now()))
}

// anonymousShape reports whether token is a block token whose (unverified) subject is the anonymous
// one. Shape only: the signed-out path verifies it in full (Anonymous) before anything is read.
func anonymousShape(token string) bool {
	if exchange.KindOf(token) != exchange.KindBlock {
		return false
	}
	parts := strings.Split(token, ".")
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var c struct {
		Sub string `json:"sub"`
	}
	return json.Unmarshal(raw, &c) == nil && c.Sub == "anon"
}

// viewer is who a shared read is for, or the refusal already answered (false).
func (s *Server) viewer(ctx context.Context, w http.ResponseWriter, start time.Time, p readParams) (shared.Viewer, bool) {
	if !anonymousShape(p.token) {
		if !s.exchangeable(p.token) {
			s.sharedRefusal(w, start, "token_not_exchangeable", false)
			return shared.Viewer{}, false
		}
		return shared.Viewer{Token: p.token}, true
	}
	if s.Anonymous == nil {
		s.sharedError(w, start, shared.ErrSignInRequired, true)
		return shared.Viewer{}, false
	}
	c, err := s.Anonymous(ctx, p.token)
	var re *exchange.RefusedError
	switch {
	case errors.As(err, &re):
		w.Header().Set("WWW-Authenticate", `Bearer realm="app-data"`)
		s.writeShared(w, start, http.StatusUnauthorized, storeErr("unauthenticated", "the block token was refused"), true, "refused")
		return shared.Viewer{}, false
	case err != nil:
		s.sharedRefusal(w, start, "unverifiable", true)
		return shared.Viewer{}, false
	case c.BlockID != p.slug:
		// The slug the token was minted for is the only app it reads.
		s.sharedError(w, start, shared.ErrBlockMismatch, true)
		return shared.Viewer{}, false
	}
	return shared.Viewer{Anonymous: &shared.Anonymous{Mask: shared.ViewerLevel(c.MaxBrowsingLevel, c.ViewerBrowsingLevel),
		AppBlockID: c.AppBlockID}}, true
}

// board reads the board for p, or answers why not (false).
func (s *Server) board(w http.ResponseWriter, r *http.Request, start time.Time, p readParams) (shared.Board, shared.Viewer, bool) {
	v, ok := s.viewer(r.Context(), w, start, p)
	if !ok {
		return shared.Board{}, v, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.LiveWait)
	defer cancel()
	b, err := s.Shared.Read(ctx, v, p.slug, p.collection, p.major, p.minSeq)
	if err != nil {
		s.sharedError(w, start, err, v.Anonymous != nil)
		return shared.Board{}, v, false
	}
	return b, v, true
}

// sharedError answers a shared read that could not be answered, never from REST.
func (s *Server) sharedError(w http.ResponseWriter, start time.Time, err error, anon bool) {
	switch {
	case errors.Is(err, shared.ErrViewerRefused):
		w.Header().Set("WWW-Authenticate", `Bearer realm="app-data"`)
		s.writeShared(w, start, http.StatusUnauthorized, storeErr("refused", "the origin refused this viewer"), anon, "refused")
	case errors.Is(err, shared.ErrBlockMismatch):
		w.Header().Set("WWW-Authenticate", `Bearer realm="app-data"`)
		s.writeShared(w, start, http.StatusUnauthorized, storeErr("refused", "the token is not for this app's approved block"), anon, "refused")
	case errors.Is(err, shared.ErrSignInRequired):
		w.Header().Set("WWW-Authenticate", `Bearer realm="app-data"`)
		s.writeShared(w, start, http.StatusUnauthorized, storeErr("sign_in_required", "sign in required"), anon, "refused")
	case errors.Is(err, shared.ErrUnkeyed):
		s.sharedRefusal(w, start, "unkeyed", anon)
	case errors.Is(err, shared.ErrOutsideWindow):
		s.sharedRefusal(w, start, "too_large", anon)
	case errors.Is(err, session.ErrFloorNotMet):
		s.sharedRefusal(w, start, "floor_not_met", anon)
	case errors.Is(err, shared.ErrServiceToken):
		// This service's own token, refused on a level stream: never the viewer's 401.
		s.sharedRefusal(w, start, "service_token_refused", anon)
	case errors.Is(err, shared.ErrSignedOutBusy):
		s.sharedRefusal(w, start, "capacity", anon)
	case errors.Is(err, shared.ErrNoServiceClient):
		// No service client is configured: no level stream can be read until one is.
		s.sharedRefusal(w, start, "service_client_unconfigured", anon)
	case errors.Is(err, shared.ErrServiceTokenRefused):
		// The hub refused to mint this service's own token (alone, or as the cause of a cooldown).
		s.sharedRefusal(w, start, "service_token_refused", anon)
	case errors.Is(err, shared.ErrServiceTokenUnavailable):
		s.sharedRefusal(w, start, "service_token_unavailable", anon)
	default:
		var ended *session.EndedError
		if errors.As(err, &ended) && ended.Reason == "not_resolved" {
			// A catalog lag, an unapproved app or a collection that is not shared: never a 401.
			s.sharedRefusal(w, start, "not_resolved", anon)
			return
		}
		s.sharedRefusal(w, start, fallbackReason(err), anon)
	}
}

// sharedRefusal is streamRefusal for a shared read, in the store's envelope, counted.
func (s *Server) sharedRefusal(w http.ResponseWriter, start time.Time, reason string, anon bool) {
	if code, ok := refusedReasons[reason]; ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="app-data"`)
		s.writeShared(w, start, http.StatusUnauthorized, storeErr(code, "the token cannot read this collection"), anon, "refused")
		return
	}
	outcome := "unavailable"
	if reason == "floor_not_met" {
		outcome = reason
	}
	w.Header().Set("Retry-After", "1")
	s.writeShared(w, start, http.StatusServiceUnavailable, storeErr(reason, "the streams cannot answer this read now; retry"), anon, outcome)
}

// storeErr is an error body read both as this service's (`error` is the code) and as the store's
// (`code`).
func storeErr(code, msg string) map[string]string {
	return map[string]string{"error": code, "code": code, "message": msg}
}

func (s *Server) writeShared(w http.ResponseWriter, start time.Time, status int, body any, anon bool, outcome string) {
	s.write(w, start, status, body, "registry", outcome)
	if anon {
		s.Metrics.SignedOutReads.WithLabelValues(outcome).Inc()
	}
}

type sharedDoc struct {
	URN       string          `json:"urn,omitempty"`
	Key       string          `json:"key"`
	Rev       string          `json:"rev"`
	Data      json.RawMessage `json:"data"`
	Version   int64           `json:"version"`
	CreatedAt string          `json:"createdAt,omitempty"`
	UpdatedAt string          `json:"updatedAt,omitempty"`
	Author    sharedAuthor    `json:"author"`
}

type sharedAuthor struct {
	IsViewer bool `json:"isViewer"`
}

func present(d shared.Doc) sharedDoc {
	return sharedDoc{URN: d.URN, Key: d.Key, Rev: d.Rev, Data: d.Data, Version: d.Version, CreatedAt: d.CreatedAt,
		UpdatedAt: d.UpdatedAt, Author: sharedAuthor{IsViewer: d.Mine}}
}

type sharedList struct {
	Source     string      `json:"source"`
	Items      []sharedDoc `json:"items"`
	NextCursor *string     `json:"nextCursor"`
}

type sharedOne struct {
	Source string    `json:"source"`
	Item   sharedDoc `json:"item"`
}

// sharedListParams are the list parameters the streams serve; anything else is not_supported_here.
var sharedListParams = map[string]bool{"keyPrefix": true, "author": true, "sort": true, "limit": true, "cursor": true,
	"major": true, "minSeq": true}

// limitRE is the store's own limit grammar (doc-store-api.ts parseListQuery).
var limitRE = regexp.MustCompile(`^[0-9]{1,3}$`)

// cursorRE is the store's key-sort cursor (doc-store.ts encodeCursor): `k<a|d>~~<key>`.
var cursorRE = regexp.MustCompile(`^k([ad])~~([A-Za-z0-9._:-]{1,128})$`)

type listQuery struct {
	prefix string
	mine   bool
	desc   bool
	limit  int
	after  string // the cursor's key; "" for the first page
}

// parseSharedList reads a shared list's query, or answers why not (false).
func (s *Server) parseSharedList(w http.ResponseWriter, r *http.Request, start time.Time) (listQuery, bool) {
	q := r.URL.Query()
	lq := listQuery{limit: listLimitDefault}
	bad := func(code, msg string) (listQuery, bool) {
		s.write(w, start, http.StatusBadRequest, storeErr(code, msg), "none", "bad_request")
		return lq, false
	}
	for name, vals := range q {
		if !sharedListParams[name] {
			return bad("not_supported_here", "the "+name+" parameter is not served for a shared collection here")
		}
		if len(vals) != 1 {
			return bad("bad_request", name+" must be given once")
		}
	}
	lq.prefix = q.Get("keyPrefix")
	switch a, given := q["author"]; {
	case !given:
	case a[0] == "me":
		lq.mine = true
	default:
		return bad("bad_request", `author must be "me"`)
	}
	switch q.Get("sort") {
	case "", "key":
	case "-key":
		lq.desc = true
	default:
		return bad("not_supported_here", "only sort=key and sort=-key are served for a shared collection here")
	}
	if raw, given := q["limit"]; given {
		n, err := strconv.Atoi(raw[0])
		if err != nil || n < 1 || n > listLimitMax || !limitRE.MatchString(raw[0]) {
			return bad("bad_request", "limit must be 1–100")
		}
		lq.limit = n
	}
	if raw, given := q["cursor"]; given {
		m := cursorRE.FindStringSubmatch(raw[0])
		if m == nil || (m[1] == "d") != lq.desc {
			return bad("bad_request", "invalid cursor")
		}
		lq.after = m[2]
	}
	return lq, true
}

// sharedList answers a shared list.
func (s *Server) sharedList(w http.ResponseWriter, r *http.Request, start time.Time, p readParams) {
	lq, ok := s.parseSharedList(w, r, start)
	if !ok {
		return
	}
	if lq.mine && anonymousShape(p.token) {
		s.sharedError(w, start, shared.ErrSignInRequired, true)
		return
	}
	b, v, ok := s.board(w, r, start, p)
	if !ok {
		return
	}
	page, next, err := pageOf(b, lq)
	if err != nil {
		s.sharedError(w, start, err, v.Anonymous != nil)
		return
	}
	out := sharedList{Source: "registry", Items: make([]sharedDoc, 0, len(page)), NextCursor: next}
	for _, d := range page {
		out.Items = append(out.Items, present(d))
	}
	s.writeShared(w, start, http.StatusOK, out, v.Anonymous != nil, "ok")
}

// pageOf is one page of b under lq, and the cursor of the next (nil when none). Below b.Floor the
// board is not known: a page that needs anything there is ErrOutsideWindow, unless what it asks for
// cannot lie there (every key with the prefix sorts at or above the prefix, so a prefix at or above
// the floor) or is the viewer's own (the per-viewer stream is never truncated).
func pageOf(b shared.Board, lq listQuery) ([]shared.Doc, *string, error) {
	below := b.Floor != "" && !lq.mine && lq.prefix < b.Floor
	var docs []shared.Doc
	for _, d := range b.Docs {
		if strings.HasPrefix(d.Key, lq.prefix) && (!lq.mine || d.Mine) {
			docs = append(docs, d)
		}
	}
	if lq.desc {
		for i, j := 0, len(docs)-1; i < j; i, j = i+1, j-1 {
			docs[i], docs[j] = docs[j], docs[i]
		}
	}
	dir := "a"
	if lq.desc {
		dir = "d"
	}
	// Ascending, a page starting below the floor would answer from the unknown part.
	if !lq.desc && below && lq.after < b.Floor {
		return nil, nil, shared.ErrOutsideWindow
	}
	var page []shared.Doc
	for _, d := range docs {
		if lq.after != "" && ((!lq.desc && d.Key <= lq.after) || (lq.desc && d.Key >= lq.after)) {
			continue
		}
		if len(page) == lq.limit {
			c := "k" + dir + "~~" + page[len(page)-1].Key
			return page, &c, nil
		}
		if lq.desc && below && d.Key < b.Floor {
			return nil, nil, shared.ErrOutsideWindow
		}
		page = append(page, d)
	}
	// Descending, a page that ran out of held documents may be missing the unknown part's.
	if lq.desc && below {
		return nil, nil, shared.ErrOutsideWindow
	}
	return page, nil, nil
}

// sharedGet answers a shared keyed get.
func (s *Server) sharedGet(w http.ResponseWriter, r *http.Request, start time.Time, p readParams, key string) {
	b, v, ok := s.board(w, r, start, p)
	if !ok {
		return
	}
	for _, d := range b.Docs {
		if d.Key == key {
			s.writeShared(w, start, http.StatusOK, sharedOne{Source: "registry", Item: present(d)}, v.Anonymous != nil, "ok")
			return
		}
	}
	if b.Floor != "" && key < b.Floor {
		s.sharedError(w, start, shared.ErrOutsideWindow, v.Anonymous != nil)
		return
	}
	s.writeShared(w, start, http.StatusNotFound, storeErr("not_found", "document not found"), v.Anonymous != nil, "not_found")
}

// parentRE is a viewer-keyed parent (docs/app-storage-generic-core.md, "Key derivation"): the key
// grammar without `:`, at most 96 characters, not only dots.
var (
	parentRE  = regexp.MustCompile(`^[A-Za-z0-9._-]{1,96}$`)
	onlyDots  = regexp.MustCompile(`^\.+$`)
	derivedRE = regexp.MustCompile(`^[a-z2-7]{26}$`)
)

// mine answers GET …/records/@me[/{parent}]: the viewer's own document of a viewer-keyed collection,
// found among their own documents (the per-viewer stream), never by deriving its key (the derivation
// key is the site's).
func (s *Server) mine(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	h := w.Header()
	cors(h)
	h.Set("Cache-Control", "private, no-store")
	h.Set("Vary", "Authorization")
	parent, hasParent := r.PathValue("parent"), r.PathValue("parent") != ""
	if hasParent && (!parentRE.MatchString(parent) || onlyDots.MatchString(parent)) {
		s.write(w, start, http.StatusBadRequest, storeErr("invalid_request", "invalid parent"), "none", "bad_request")
		return
	}
	p, ok := s.params(w, r, start)
	if !ok {
		return
	}
	if anonymousShape(p.token) {
		s.sharedError(w, start, shared.ErrSignInRequired, true)
		return
	}
	b, _, ok := s.board(w, r, start, p)
	if !ok {
		return
	}
	reason := ""
	switch {
	case b.KeyedBy == "":
		reason = "not_viewer_keyed"
	case b.KeyedBy == "viewer" && hasParent:
		reason = "parent_not_allowed"
	case b.KeyedBy == "parent+viewer" && !hasParent:
		reason = "parent_required"
	}
	if reason != "" {
		body := map[string]any{"error": "invalid_request", "code": "invalid_request", "message": "not a request this collection takes",
			"details": map[string]string{"reason": reason}}
		s.write(w, start, http.StatusBadRequest, body, "registry", "bad_request")
		return
	}
	for _, d := range b.Docs {
		k := d.Key
		if hasParent {
			rest, ok := strings.CutPrefix(k, parent+":")
			if !ok {
				continue
			}
			k = rest
		}
		if d.Mine && derivedRE.MatchString(k) {
			s.write(w, start, http.StatusOK, sharedOne{Source: "registry", Item: present(d)}, "registry", "ok")
			return
		}
	}
	s.write(w, start, http.StatusNotFound, storeErr("not_found", "document not found"), "registry", "not_found")
}
