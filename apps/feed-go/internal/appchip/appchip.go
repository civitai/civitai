// Package appchip answers `image.getPublishedWithApp` (the image page's "Published with <app>" credit)
// for the requests whose answer is `null` whatever the viewer, and hands every other one back.
//
// The Node procedure (getImagePublishedWithAppHandler → readImageAppChip → readAppChip →
// resolveAppChip, src/server/services/blocks/) answers a chip only when ALL of these hold: the store
// scope admits an on-site listing for the viewer (Flipt, per user), the image is visible to the
// viewer (image.get's visibility predicate and blocked-user check, the minor content rule among
// them), the viewer may see its media (the domain cap, the collection-manager exemption), the
// image's own `metadata.blockPublishedAppId` is a non-blank string, and that marker resolves to an
// app the request's host may name. Every other path, including any error, answers `null`.
//
// The marker is the one term that does not depend on the viewer, and without it no other term can
// produce a chip. So this package reads only the image's marker (one primary-key read of the
// replica, the table Node's own marker read uses): no marker, or no image, is Node's `null` for
// every viewer, scope, host and level, and is served; a marker is the `published-app-marked`
// fallback, because the scope gate, the visibility rules and the app resolution that then decide
// the answer are not ported. Serving the null case needs none of the image feed's visibility code:
// the answer it serves is the same whether or not the viewer may see the image, so it discloses
// nothing about the image either way (DESIGN.md §18).
package appchip

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// MarkerKey is BLOCK_PUBLISHED_APP_ID_META_KEY (src/shared/utils/block-provenance-metadata.ts): the
// `Image.metadata` key persistBlockWorkflowOutputImage stamps with the publishing app's id.
const MarkerKey = "blockPublishedAppId"

// The viewer classes an answer reports, a fixed set (a metric label): signed out, a moderator, the
// image's owner, any other signed-in viewer. A signed-in browser batches this procedure when tRPC
// batching is on for it and the Node sampler never samples a batched call, so signed-in coverage is
// read per class (DESIGN.md §18.3).
const (
	ViewerAnon      = "anon"
	ViewerUser      = "user"
	ViewerOwner     = "owner"
	ViewerModerator = "moderator"
)

// ViewerClasses is every viewer class, in a fixed order.
var ViewerClasses = []string{ViewerAnon, ViewerUser, ViewerOwner, ViewerModerator}

// Querier is the replica (implemented by *pgxpool.Pool).
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Deps are the stores the procedure reads.
type Deps struct {
	// DB is the read replica.
	DB Querier
}

// Viewer is the session user.
type Viewer struct {
	ID          int
	IsModerator bool
}

// Request is one call.
type Request struct {
	Input *Input
	// Viewer is the session user; nil signed out.
	Viewer *Viewer
	// Banned is a banned user's session (Viewer is then nil).
	Banned bool
}

// Answer is one computed answer.
type Answer struct {
	// Value is the procedure's answer: always nil (`null`) here, the only answer this package serves.
	Value any
	// Trivial: answered without reading the image (an id no int4 column holds).
	Trivial bool
	// ViewerClass is the sample's viewer class (one of ViewerClasses).
	ViewerClass string
}

// Input is getByIdSchema (src/server/schema/base.schema.ts: `z.object({ id: z.number() })`) as the
// procedure reads it.
type Input struct {
	// ID is `id` as the JS number zod accepted.
	ID float64
}

// Int4 is isPgInt4 (src/server/db/prisma-sql-kysely.ts): an integer an int4 column can hold.
func (in *Input) Int4() (int32, bool) {
	if in.ID != math.Trunc(in.ID) || in.ID < math.MinInt32 || in.ID > math.MaxInt32 {
		return 0, false
	}
	return int32(in.ID), true
}

// schemaKeys are the schema's keys; transportKeys are the keys the site's tRPC client adds to every
// input (`authed`, `direction`) and zod strips. Any other key is a fallback (`input-unknown-key`), so a
// key the app adds to the schema is never read as absent here.
var (
	schemaKeys    = map[string]bool{"id": true}
	transportKeys = map[string]bool{"authed": true, "direction": true}
)

// Parse validates the decoded input map (trpc.ParseInput). What the schema refuses (Node answers it
// with a 400 the sampler never mirrors) falls back as `input-invalid`.
func Parse(m map[string]any) (*Input, error) {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !schemaKeys[k] && !transportKeys[k] {
			return nil, fallback.NewfSafe("input-unknown-key", fallback.Token(k), "%s", k)
		}
	}
	n, ok := m["id"].(json.Number)
	if !ok {
		// Absent, null, a string (a superjson bigint arrives as one), a boolean: z.number() refuses it.
		return nil, fallback.NewfSafe("input-invalid", "id", "id %v", m["id"])
	}
	// JSON.parse's reading of the literal: the nearest double. A literal past the double range is
	// Infinity in JS; not ported.
	f, err := strconv.ParseFloat(n.String(), 64)
	if err != nil {
		return nil, fallback.NewfSafe("input-invalid", "id", "id: %v", err)
	}
	return &Input{ID: f}, nil
}

// imageMarkerSQL reads the image's owner and its marker value as JSON (NULL when the metadata is not
// an object or has no such key). No visibility term, deliberately: the answer served from it is the
// same for every viewer (see the package doc).
const imageMarkerSQL = `SELECT "userId", "metadata" -> '` + MarkerKey + `' FROM "Image" WHERE "id" = $1`

// Serve answers one request, or returns a fallback (or a store error).
func Serve(ctx context.Context, d *Deps, req Request) (*Answer, error) {
	if d == nil || d.DB == nil {
		return nil, fallback.New("published-app-unconfigured")
	}
	if false && req.Banned {
		// Node moves a banned session's user off `ctx.user` and keeps the session's cache policy; the
		// chip's answer is null either way, but that pairing is not ported.
		return nil, fallback.New("published-app-banned-session")
	}
	id, ok := req.Input.Int4()
	if !ok {
		// assertImageVisibleToViewer: an id past int4 (or a fraction) names no image, NOT_FOUND, which
		// readImageAppChip answers null; a gated viewer gets null before that. No read either way.
		return &Answer{Trivial: true, ViewerClass: viewerClass(req.Viewer, 0)}, nil
	}
	owner, marker, found, err := readMarker(ctx, d.DB, id)
	if err != nil {
		return nil, err
	}
	if !found {
		// No such image: the visibility read finds nothing (NOT_FOUND → null), or the gate answered null.
		return &Answer{ViewerClass: viewerClass(req.Viewer, 0)}, nil
	}
	if Marked(marker) {
		return nil, fallback.New("published-app-marked")
	}
	return &Answer{ViewerClass: viewerClass(req.Viewer, owner)}, nil
}

// readMarker is the image's owner and its marker's JSON (nil = no such key), and whether the row exists.
func readMarker(ctx context.Context, db Querier, id int32) (owner int, marker []byte, found bool, err error) {
	rows, err := db.Query(ctx, imageMarkerSQL, id)
	if err != nil {
		return 0, nil, false, err
	}
	defer rows.Close()
	if rows.Next() {
		if err := rows.Scan(&owner, &marker); err != nil {
			return 0, nil, false, err
		}
		found = true
	}
	return owner, marker, found, rows.Err()
}

// Marked reports whether a marker value (its JSON, nil when the key is absent) could name an app:
// readAppIdMarker (post-app-chip.logic.ts) takes a string whose trim is non-empty. Any non-empty
// string counts here, a whitespace-only one included: deciding JS's trim is not needed to stay exact,
// because a marked image falls back and Node then answers it. Not a string (absent, null, a number,
// an object): no marker, and Node's answer is null.
func Marked(raw []byte) bool {
	if raw == nil {
		return false
	}
	var s string
	err := json.Unmarshal(raw, &s)
	var typeErr *json.UnmarshalTypeError
	switch {
	case err == nil:
		// JSON null leaves s empty: not a string, no marker.
		return s != ""
	case errors.As(err, &typeErr):
		// A JSON value that is not a string.
		return false
	default:
		// Unreadable (a jsonb column never yields one): not decided here, so it falls back.
		return true
	}
}

// viewerClass is the class of viewer for an image owned by owner (0 = no row).
func viewerClass(viewer *Viewer, owner int) string {
	switch {
	case viewer == nil || viewer.ID == 0:
		return ViewerAnon
	case viewer.IsModerator:
		return ViewerModerator
	case owner != 0 && viewer.ID == owner:
		return ViewerOwner
	}
	return ViewerUser
}
