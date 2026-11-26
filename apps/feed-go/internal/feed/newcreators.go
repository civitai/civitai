package feed

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/clock"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// NewCreatorsKey is REDIS_KEYS.CACHES.NEW_CREATORS: getNewCreatorUserIds' fetchThroughCache entry is
// `<key>:<boardId>`, `{data: number[], cachedAt: <epoch ms>}` (packed).
const NewCreatorsKey = "packed:caches:new-creators"

// NewCreatorsTTL is getNewCreatorUserIds' fetchThroughCache ttl (CacheTTL.hour): an entry older than
// this is refreshed (or served stale under another caller's lock) by Node.
const NewCreatorsTTL = time.Hour

// NewCreatorBoardID is getNewCreatorBoardId('images', domain) (src/server/services/new-creators.service.ts):
// red has its own board; every other color, or none, reads the SFW one.
func NewCreatorBoardID(boardColor string) string {
	if boardColor == "red" {
		return "images-new-red"
	}
	return "images-new"
}

// NewCreatorBoards reads getNewCreatorUserIds' cached board for image.getInfinite's `newCreators`
// (no maxFollowers: the procedure never sets it). Only a fresh entry is answered: Node rebuilds a
// missing one from the database and refreshes an expired one (or serves it stale while another
// caller holds the lock, which this service cannot tell), so those fall back (`new-creators-miss`,
// `new-creators-stale`), as does a read error (`new-creators-read-failed`: Node fails open to the
// database).
type NewCreatorBoards struct {
	Cache  redis.UniversalClient
	Prefix string
	// Now is the staleness clock (nil = time.Now; tests replace it).
	Now func() time.Time
}

// UserIDs is the board's creator ids, in board order.
func (b *NewCreatorBoards) UserIDs(ctx context.Context, boardID string) ([]int, error) {
	if b == nil || b.Cache == nil {
		return nil, fallback.New("new-creators-unconfigured")
	}
	raw, err := b.Cache.Get(ctx, b.Prefix+NewCreatorsKey+":"+boardID).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, fallback.New("new-creators-miss")
	}
	if err != nil {
		return nil, fallback.Wrap("new-creators-read-failed", err)
	}
	now := clock.Now
	if b.Now != nil {
		now = b.Now
	}
	return parseNewCreators(raw, now())
}

// parseNewCreators reads a fetchThroughCache entry of the board. An entry fetchThroughCache treats as a
// miss (undecodable, no `data`, a `cachedAt` that is not a number) is `new-creators-miss`; one older
// than the ttl (`Date.now() - ttl * 1000 > cachedAt`) is `new-creators-stale`; a `data` that is not a
// list of integers (no writer produces one) is `new-creators-stale` too, rather than guessing how each
// Node path reads it.
func parseNewCreators(raw []byte, now time.Time) ([]int, error) {
	v, err := hydrate.Unpack(raw)
	if err != nil {
		return nil, fallback.New("new-creators-miss")
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fallback.New("new-creators-miss")
	}
	data, has := m["data"]
	if !has {
		return nil, fallback.New("new-creators-miss")
	}
	at, ok := hydrate.Float(m["cachedAt"])
	if !ok {
		return nil, fallback.New("new-creators-miss")
	}
	if float64(now.UnixMilli())-float64(NewCreatorsTTL/time.Millisecond) > at {
		return nil, fallback.New("new-creators-stale")
	}
	list, ok := data.([]any)
	if !ok {
		return nil, fallback.New("new-creators-stale")
	}
	out := make([]int, 0, len(list))
	for _, e := range list {
		f, ok := hydrate.Float(e)
		if !ok || f != math.Trunc(f) || f < math.MinInt32 || f > math.MaxInt32 {
			return nil, fallback.New("new-creators-stale")
		}
		out = append(out, int(f))
	}
	return out, nil
}
