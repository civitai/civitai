package v1models

import (
	"context"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

// KeyTrainingDataRulesLive is REDIS_KEYS.FEED_GO.TRAINING_DATA_RULES_LIVE, on the cache cluster: a
// hash whose fields are the Training Data rule set ids (trainingDataListingRulesId) of the Node
// builds now answering the public model routes. Each Node process answering one writes its id at
// most once a minute, each field expiring 5 minutes after its last write
// (src/server/services/feed-go-training-data-rules.ts), so the live fields are the builds still
// answering.
const KeyTrainingDataRulesLive = "feed-go:training-data-rules-live"

// TrainingDataRulesTTL is how long one read of the hash is served from memory.
const TrainingDataRulesTTL = 15 * time.Second

// trainingDataRulesReadTimeout bounds the one shared read of a refresh (detached from any one
// caller's context, as BlockedTags' is).
const trainingDataRulesReadTimeout = 2 * time.Second

// TrainingDataRules vouches, on the public serve path, for this build's Training Data rules: a
// served body with a Training Data candidate is listed only when the live Node builds all list by
// TrainingDataSQLHash. That holds while the hash's fields are exactly that id: none (no Node build
// has said), another (a Node deploy that changed the rules, still rolling out or done), or a read
// that fails, and the body falls back (`v1-models-training-data-drift`), as a shadow sample without
// the header does. A shadow sample is vouched for by its own header instead (DESIGN.md §16.6).
//
// A read is served from memory for TTL; a failed read is never memoized. Concurrent callers of an
// expired memo share one read.
type TrainingDataRules struct {
	Redis  redis.UniversalClient
	Prefix string
	// TTL is the memo's lifetime (0 = TrainingDataRulesTTL; negative = no memo).
	TTL time.Duration
	// Now is the memo's clock (nil = time.Now).
	Now func() time.Time

	mu      sync.Mutex
	known   bool
	vouched bool
	readAt  time.Time
	refresh singleflight.Group
}

// Vouched reports whether the Node builds now answering list Training Data files by exactly this
// build's rules. A nil receiver vouches for nothing.
func (t *TrainingDataRules) Vouched(ctx context.Context) bool {
	if t == nil || t.Redis == nil {
		return false
	}
	ttl := t.TTL
	if ttl == 0 {
		ttl = TrainingDataRulesTTL
	}
	now := time.Now
	if t.Now != nil {
		now = t.Now
	}
	if ttl > 0 {
		t.mu.Lock()
		v, fresh := t.vouched, t.known && now().Sub(t.readAt) < ttl
		t.mu.Unlock()
		if fresh {
			return v
		}
	}
	ch := t.refresh.DoChan("read", func() (any, error) {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), trainingDataRulesReadTimeout)
		defer cancel()
		fields, err := t.Redis.HGetAll(rctx, t.Prefix+KeyTrainingDataRulesLive).Result()
		if err != nil {
			return false, err
		}
		v := liveRulesAre(fields, TrainingDataSQLHash)
		t.mu.Lock()
		t.known, t.vouched, t.readAt = true, v, now()
		t.mu.Unlock()
		return v, nil
	})
	select {
	case <-ctx.Done():
		return false
	case res := <-ch:
		if res.Err != nil {
			return false
		}
		return res.Val.(bool)
	}
}

// liveRulesAre reports whether the live rule set ids are exactly id.
func liveRulesAre(fields map[string]string, id string) bool {
	if len(fields) != 1 {
		return false
	}
	_, ok := fields[id]
	return ok
}
