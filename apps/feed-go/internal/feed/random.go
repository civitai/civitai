package feed

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// SortRandom is ImageSort.Random. getAllImages answers it only beside a collectionId (without one,
// 'Random sort requires a collectionId', a BAD_REQUEST), so ParseInfiniteWith accepts it only beside
// one, and only with InfinitePorts.SortRandom.
const SortRandom = "Random"

// RandomSeedKey is REDIS_SYS_KEYS.COLLECTION.RANDOM_SEED, on the system redis: the hourly seed a
// collection's Random order hashes its items with (getCollectionRandomSeed in
// src/server/services/collection.service.ts; the hourly job and a reader's miss write it).
const RandomSeedKey = "collection:random-seed"

// randomPartRE is a cursor part or a stored seed this service reads as Node does: digits only, few
// enough that the integer is exact in a JS number and in an int64.
var randomPartRE = regexp.MustCompile(`^\d{1,15}$`)

// RandomSeed reads the collection Random seed (getCollectionRandomSeed's read half).
type RandomSeed struct {
	Sys redis.UniversalClient
}

// Seed is the stored seed. Node's getCollectionRandomSeed answers a missing key by computing the
// hour's seed and WRITING it (and a failed read by the hour's seed, unwritten); this service writes
// nothing to the system redis, so a missing key is the `collection-random-seed-miss` fallback and a
// failed read `collection-random-seed-read-failed` (Node then decides, and writes the key). A stored
// value Node would not read as the same integer this service binds (`Number(cached)` of anything but
// digits: a fraction, a sign, NaN; or 0, which Node's `!collectionSeed` replaces) is
// `collection-random-seed-stale`.
func (s *RandomSeed) Seed(ctx context.Context) (int64, error) {
	if s == nil || s.Sys == nil {
		return 0, fallback.New("collection-random-seed-unconfigured")
	}
	raw, err := s.Sys.Get(ctx, RandomSeedKey).Result()
	if errors.Is(err, redis.Nil) || (err == nil && raw == "") {
		return 0, fallback.New("collection-random-seed-miss")
	}
	if err != nil {
		return 0, fallback.Wrap("collection-random-seed-read-failed", err)
	}
	n, ok := randomPart(raw)
	if !ok || n == 0 {
		return 0, fallback.New("collection-random-seed-stale")
	}
	return n, nil
}

// randomPart reads one digits-only part as an integer.
func randomPart(s string) (int64, bool) {
	if !randomPartRE.MatchString(s) {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil
}

// RandomCursor is a Random page's cursor as getAllImages reads it: `seed:sortKey:id`.
type RandomCursor struct {
	// Seed is the cursor's seed; 0 when it is falsy in Node (the stored seed is then read).
	Seed int64
	// SortKey and ID page the CTE: `"sortKey" < SortKey OR ("sortKey" = SortKey AND "imageId" < ID)`.
	SortKey, ID int64
}

// parseRandomCursor is getAllImages' Random cursor parse for the input's cursor: `String(cursor)`
// split on ':'. Anything but three parts (a number, any other string) is no cursor at all there: the
// first page, with no cursor clause (ok, nil). Three parts are bound as Node inlines them: each part
// is read here only when it is digits (Number() of it is then the same integer, and Node writes it
// into the SQL as that integer); any other part is `collection-random-cursor` (Node would inline NaN,
// a sign or a fraction, which this service does not reproduce). A falsy cursor (absent, 0, "") is no
// cursor.
func parseRandomCursor(in *Input) (*RandomCursor, error) {
	var s string
	switch {
	case in.CursorText != "":
		s = in.CursorText
	case in.Cursor != 0:
		s = strconv.Itoa(in.Cursor)
	default:
		return nil, nil
	}
	parts := strings.Split(s, ":")
	if len(parts) != 3 {
		return nil, nil
	}
	var vals [3]int64
	for i, p := range parts {
		n, ok := randomPart(p)
		if !ok {
			return nil, fallback.New("collection-random-cursor")
		}
		vals[i] = n
	}
	return &RandomCursor{Seed: vals[0], SortKey: vals[1], ID: vals[2]}, nil
}
