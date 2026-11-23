package v1models

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// KeyTrainingDataRulesLive is REDIS_KEYS.FEED_GO.TRAINING_DATA_RULES_LIVE, on the cache cluster: a
// hash whose fields are the Training Data rule set ids (trainingDataListingRulesId) of the Node
// builds now answering the public model routes; written and expired by
// src/server/services/feed-go-training-data-rules.ts.
const KeyTrainingDataRulesLive = "feed-go:training-data-rules-live"

// trainingDataRulesReadTimeout bounds the read, within the caller's own context.
const trainingDataRulesReadTimeout = 2 * time.Second

// TrainingDataRules vouches, on the public serve path, for this build's Training Data rules: a
// served body with a Training Data candidate is listed only when the live Node builds all list by
// TrainingDataSQLHash, so it vouches only while the hash's fields are exactly that id. No field (no
// Node build has said), another id (a Node deploy that changed the rules, still rolling out or done)
// or a failed read makes the body fall back (`v1-models-training-data-drift`), as a shadow sample
// without the header does. A shadow sample is vouched for by its own header instead (DESIGN.md §16.6).
//
// Every call is one HGETALL (nothing is kept in memory); the listing calls it only for a body with
// a Training Data candidate.
type TrainingDataRules struct {
	Redis  redis.UniversalClient
	Prefix string
}

// Vouched reports whether the Node builds now answering list Training Data files by exactly this
// build's rules. A nil receiver vouches for nothing.
func (t *TrainingDataRules) Vouched(ctx context.Context) bool {
	if t == nil || t.Redis == nil {
		return false
	}
	rctx, cancel := context.WithTimeout(ctx, trainingDataRulesReadTimeout)
	defer cancel()
	fields, err := t.Redis.HGetAll(rctx, t.Prefix+KeyTrainingDataRulesLive).Result()
	if err != nil {
		return false
	}
	return liveRulesAre(fields, TrainingDataSQLHash)
}

// liveRulesAre reports whether the live rule set ids are exactly id.
func liveRulesAre(fields map[string]string, id string) bool {
	if len(fields) != 1 {
		return false
	}
	_, ok := fields[id]
	return ok
}
