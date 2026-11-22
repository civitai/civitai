package listingread

import (
	"cmp"
	"encoding/base64"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// The store grid's sorts (listingSortSchema).
const (
	SortTopRated = "top-rated"
	SortPopular  = "popular"
	SortNewest   = "newest"
	SortName     = "name"
)

// Constants of the store's sort keys (app-listing.service.ts).
const (
	// bayesPrior is LISTING_BAYES_PRIOR: how many reviews at the mean a listing is seeded with.
	bayesPrior = 10.0
	// bayesScale and bayesPad are BAYES_SCORE_SCALE and BAYES_SCORE_PAD.
	bayesScale = 1_000_000
	bayesPad   = 9
	// countPad is COUNT_PAD.
	countPad = 20
	// defaultMean is DEFAULT_RECOMMEND_MEAN: the mean when no listing has a review.
	defaultMean = 0.5
	// nameKeyLen is the `left(LOWER(al.name), 64)` of the name sort.
	nameKeyLen = 64
)

// lpad mirrors Postgres lpad(text, n, '0') over a number's text: padded on the left with zeros
// to n characters, and cut to its first n when longer.
func lpad(n int64, width int) string {
	s := strconv.FormatInt(n, 10)
	if len(s) >= width {
		return s[:width]
	}
	return strings.Repeat("0", width-len(s)) + s
}

// popularKey mirrors listingPopularSortKey: the plays (open count) of an on-site listing, the
// installs of any other, then the installs, each zero-padded to 20 digits.
func popularKey(l store.Listing) string {
	usage := orZero(l.Stats.InstallCount)
	if l.Kind == "onsite" {
		usage = orZero(l.Stats.OpenCount)
	}
	return lpad(usage, countPad) + lpad(orZero(l.Stats.InstallCount), countPad)
}

// bayesKey mirrors listingBayesianSortKey: the Bayesian recommend score
// (PRIOR·mean + up) / (PRIOR + up + down), scaled to a millionth and zero-padded to 9 digits, then
// the popular key. The rounding is to nearest-even: Postgres's round(double precision) rounds with
// the platform's rint, which is round-half-even.
func bayesKey(l store.Listing, mean float64) string {
	up, down := float64(orZero(l.Stats.RecommendedCount)), float64(orZero(l.Stats.NotRecommendedCount))
	score := (bayesPrior*mean + up) / (bayesPrior + up + down)
	return lpad(int64(math.RoundToEven(score*bayesScale)), bayesPad) + popularKey(l)
}

// newestKey mirrors `to_char(al.created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS')`. A listing
// without a creation time (the column is never null on the site) has the empty key, last.
func newestKey(t *time.Time) string {
	if t == nil {
		return ""
	}
	u := t.UTC()
	return u.Format("20060102150405") + fmt.Sprintf("%06d", u.Nanosecond()/1000)
}

// nameKey mirrors `left(LOWER(al.name), 64)`: the name lower-cased, its first 64 characters.
func nameKey(name string) string {
	r := []rune(strings.ToLower(name))
	if len(r) > nameKeyLen {
		r = r[:nameKeyLen]
	}
	return string(r)
}

// sortKey is l's key for sort (listingSortKeyExpr), and whether that sort is descending.
func sortKey(sort string, l store.Listing, mean float64) (string, bool) {
	switch sort {
	case SortTopRated:
		return bayesKey(l, mean), true
	case SortPopular:
		return popularKey(l), true
	case SortNewest:
		return newestKey(l.CreatedAt), true
	default:
		return nameKey(l.Name), false
	}
}

// GlobalMean mirrors getGlobalRecommendMean over the listings the read model holds: the mean of
// up / (up + down) over the listings with at least one review, or 0.5 with none. The site averages
// over every approved listing, restricted ones included, which the read model never sees
// (LISTINGS-READ-MODEL.md, "Sort and paging", the first of its "Known divergences").
func GlobalMean(keys []store.Listing) float64 {
	var sum float64
	var n int
	for _, l := range keys {
		up, down := orZero(l.Stats.RecommendedCount), orZero(l.Stats.NotRecommendedCount)
		if up+down > 0 {
			sum += float64(up) / float64(up+down)
			n++
		}
	}
	if n == 0 {
		return defaultMean
	}
	return sum / float64(n)
}

// cursorVersion marks a cursor this package minted. The database path's cursors are `v2`; one of
// those, a slug-keyed `rm1` cursor of an earlier layout, or any cursor that does not decode, pages
// from the start (as decodeListingCursor does), so a cursor never compares against a key of another
// shape or another tie-break.
const cursorVersion = "rm2"

const cursorSep = "\x1f"

// EncodeCursor is the keyset cursor after a row: base64url("rm2␟key␟id[␟mean]"), the database
// cursor's fields (encodeListingCursor) under this package's version. The top-rated sort pins the
// global mean in the cursor for the whole paging session.
func EncodeCursor(key, id string, mean *float64) string {
	fields := []string{cursorVersion, key, id}
	if mean != nil {
		fields = append(fields, strconv.FormatFloat(*mean, 'g', -1, 64))
	}
	return base64.RawURLEncoding.EncodeToString([]byte(strings.Join(fields, cursorSep)))
}

// cursor is a decoded keyset cursor; ok false is "no cursor" (the first page).
type cursor struct {
	ok      bool
	key, id string
	mean    *float64
}

// decodeCursor mirrors decodeListingCursor: anything malformed or of another version is the first
// page, and a mean outside [0, 1] is dropped (the fresh mean is used).
func decodeCursor(s string) cursor {
	if s == "" {
		return cursor{}
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	if err != nil {
		return cursor{}
	}
	parts := strings.Split(string(raw), cursorSep)
	if len(parts) < 3 || len(parts) > 4 || parts[0] != cursorVersion {
		return cursor{}
	}
	c := cursor{ok: true, key: parts[1], id: parts[2]}
	if len(parts) == 4 {
		if m, err := strconv.ParseFloat(parts[3], 64); err == nil && m >= 0 && m <= 1 {
			c.mean = &m
		}
	}
	return c
}

// ListQuery is one grid request (listAppListingsSchema, less `query`).
type ListQuery struct {
	Kind     string // "" = all, else onsite or offsite
	Category string // "" = any
	UserID   *int64 // the developer filter
	Sort     string // one of the Sort* constants
	Cursor   string
	Limit    int
	// SubListings mixes each admitted listing's sub-listings into the page, as listAvailableListings
	// does with `includeSubListings` (the web tier sets it only when the database read would).
	SubListings bool
}

// Page is one ranked page, in order, and the cursor of the next page ("" when this is the last).
// URNs[i] is the listing of the page's i-th card: the card itself, or, when SubListings[i] is not
// "", the listing whose sub-listing SubListings[i] is the card. The two have the same length.
type Page struct {
	URNs        []string
	SubListings []string
	NextCursor  string
}

func (p *Page) add(urn, sub string) {
	p.URNs = append(p.URNs, urn)
	p.SubListings = append(p.SubListings, sub)
}

// Filter mirrors storeEligibilityWhere's request terms over the viewer gate (Admits): the kind and
// category filters and the developer filter.
func Filter(keys []store.Listing, kind, category string, userID *int64, v Viewer) []store.Listing {
	var out []store.Listing
	for _, l := range keys {
		switch {
		case !Admits(l, v):
		case kind != "" && l.Kind != kind:
		case category != "" && l.Category != category:
		case userID != nil && (l.CreatorID == nil || *l.CreatorID != *userID):
		default:
			out = append(out, l)
		}
	}
	return out
}

// SubListingAdmits is the store grid's gate on a sub-listing of a listing the grid already admits
// (Filter): the mature rule over the item's own rating (subListingMatureFilter reads
// s.content_rating, the same rule as listingMatureFilter). Everything else the child arm checks (an
// approved item, an active author, the parent's sub-listing switch, a working link) is applied
// upstream: such an item is not in the stream.
func SubListingAdmits(s store.SubListing, v Viewer) bool {
	return matureRatingsAllowed(v.RedCapable, v.BrowsingLevel).Admits(s.ContentRating)
}

// subListingSortKey is a sub-listing's key for sort (subListingSortKeyExpr): the parent's key for
// the rating and popularity sorts, so it ties with its parent; its own sort time and title for the
// others.
func subListingSortKey(sort string, parent store.Listing, s store.SubListing, mean float64) string {
	switch sort {
	case SortTopRated, SortPopular:
		k, _ := sortKey(sort, parent, mean)
		return k
	case SortNewest:
		return newestKey(s.SortTime)
	default:
		return nameKey(s.Title)
	}
}

// cardTB is the store's tie-break between a listing and a sub-listing on one sort key: 0 for a
// listing, 1 for a sub-listing, so a parent sorts before its children (the `tb` of
// listAvailableListings). A cursor's is read from its id, as the database reads `cursorTb`.
func cardTB(id string) int {
	if store.IsSubListingID(id) {
		return 1
	}
	return 0
}

// Rank mirrors listAvailableListings' keyset page over the listings keys holds, for v:
//
//	WHERE <Filter> AND (no cursor OR (sort_key, tb, id) after (cursor_key, cursor_tb, cursor_id))
//	ORDER BY sort_key DIR, tb ASC, id DIR LIMIT limit + 1
//
// where tb is 0 for a listing and 1 for a sub-listing (cardTB), and only with q.SubListings are
// sub-listings rows at all (each admitted listing's items that SubListingAdmits admits, keyed by
// subListingSortKey). Without them every row's tb is 0, which is the parents-only statement: a
// cursor on a sub-listing (the flag turned off between two pages) then resumes strictly after its
// key, as that statement's parentKeyset does. Keys and ids compare as bytes; the database compares
// them under its collation, which can only differ for the name sort (ids are `apl_` or `asl_` and a
// ULID, the same order either way). Listed in LISTINGS-READ-MODEL.md, "Sort and paging", "Known
// divergences". top-rated uses the cursor's pinned mean when it has one, else GlobalMean over every
// listing held (not only those v may see, as the site's mean is not per viewer).
func Rank(keys []store.Listing, q ListQuery, v Viewer) Page {
	c := decodeCursor(q.Cursor)
	var mean float64
	var pinned *float64
	if q.Sort == SortTopRated {
		mean = GlobalMean(keys)
		if c.mean != nil {
			mean = *c.mean
		}
		pinned = &mean
	}
	type row struct {
		key      string
		tb       int
		id       string
		urn, sub string
	}
	_, desc := sortKey(q.Sort, store.Listing{}, mean)
	rows := []row{}
	for _, l := range Filter(keys, q.Kind, q.Category, q.UserID, v) {
		k, _ := sortKey(q.Sort, l, mean)
		rows = append(rows, row{key: k, id: l.ID, urn: l.URN})
		if !q.SubListings {
			continue
		}
		for _, s := range l.SubListings {
			if SubListingAdmits(s, v) {
				rows = append(rows, row{key: subListingSortKey(q.Sort, l, s, mean), tb: 1, id: s.ID, urn: l.URN, sub: s.ID})
			}
		}
	}
	dir := func(c int) int {
		if desc {
			return -c
		}
		return c
	}
	order := func(a, b row) int {
		if c := strings.Compare(a.key, b.key); c != 0 {
			return dir(c)
		}
		// Ascending in every sort: a parent before its children.
		if a.tb != b.tb {
			return cmp.Compare(a.tb, b.tb)
		}
		return dir(strings.Compare(a.id, b.id))
	}
	slices.SortFunc(rows, order)
	if c.ok {
		at := row{key: c.key, tb: cardTB(c.id), id: c.id}
		rows = slices.DeleteFunc(rows, func(r row) bool { return order(r, at) <= 0 })
	}
	limit := q.Limit
	var p Page
	for i, r := range rows {
		if i == limit {
			last := rows[limit-1]
			p.NextCursor = EncodeCursor(last.key, last.id, pinned)
			break
		}
		p.add(r.urn, r.sub)
	}
	return p
}

// MaxSlugs bounds a slug hydration (GET /listings?slugs=): one store grid page.
const MaxSlugs = 50

// BySlugs mirrors listStoreListingsBySlugs: the listings slugs name that v could find in the store
// grid with the same kind and category (Filter, the list path's gate), in the order of slugs, each
// once (idsInSlugOrder: the first mention wins). A slug the viewer could not find there, or that
// no listing has, is left out. One page: no cursor.
func BySlugs(keys []store.Listing, slugs []string, kind, category string, v Viewer) Page {
	bySlug := map[string]string{}
	for _, l := range Filter(keys, kind, category, nil, v) {
		bySlug[l.Slug] = l.URN
	}
	seen := map[string]bool{}
	var p Page
	for _, s := range slugs {
		urn, ok := bySlug[s]
		if !ok || seen[urn] {
			continue
		}
		seen[urn] = true
		p.add(urn, "")
	}
	return p
}

// MaxSubListingIDs bounds a sub-listing hydration (GET /listings?subListingIds=): one store grid
// page.
const MaxSubListingIDs = 50

// BySubListingIDs mirrors listStoreSubListingsByIds: the sub-listings ids names that v could find
// in the store grid with sub-listings on and the same kind, category and developer filter (Filter on
// the parent, SubListingAdmits on the item), in the order of ids, each once. An id the viewer could
// not find there, or that no listing holds, is left out. One page: no cursor.
func BySubListingIDs(keys []store.Listing, ids []string, kind, category string, userID *int64, v Viewer) Page {
	parentOf := map[string]string{}
	for _, l := range Filter(keys, kind, category, userID, v) {
		for _, s := range l.SubListings {
			if SubListingAdmits(s, v) {
				parentOf[s.ID] = l.URN
			}
		}
	}
	seen := map[string]bool{}
	var p Page
	for _, id := range ids {
		urn, ok := parentOf[id]
		if !ok || seen[id] {
			continue
		}
		seen[id] = true
		p.add(urn, id)
	}
	return p
}
