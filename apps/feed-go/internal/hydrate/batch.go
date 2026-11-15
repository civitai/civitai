package hydrate

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// Batch collects the cache reads of one dependency stage and sends them in ONE Pipelined call per
// client, instead of one per lookup. A cluster client splits a pipeline per shard node, starting a
// goroutine and paying a round trip on each, so every Pipelined call a page saves is that cost once
// per shard.
//
// Use: queue every read (PackedReader.Queue, Sources.queueMetrics), call Exec once, then read each
// handle. A handle is read by one goroutine; distinct handles may be read concurrently (each owns its
// commands, and Exec has returned before any is read).
type Batch struct {
	groups []*batchGroup
}

// batchGroup is the commands of one client, queued in order.
type batchGroup struct {
	client redis.UniversalClient
	queue  []func(context.Context, redis.Pipeliner)
}

func NewBatch() *Batch { return &Batch{} }

func (b *Batch) add(client redis.UniversalClient, fn func(context.Context, redis.Pipeliner)) {
	for _, g := range b.groups {
		if g.client == client {
			g.queue = append(g.queue, fn)
			return
		}
	}
	b.groups = append(b.groups, &batchGroup{client: client, queue: []func(context.Context, redis.Pipeliner){fn}})
}

// Exec sends the queued commands, one Pipelined call per client; a batch with nothing queued sends
// nothing. The pipeline's own error is not inspected: every handle reads its own commands' errors (a
// command that failed, redis.Nil included, is a miss or a read failure as that lookup defines it), so
// a failure on one shard never masks another lookup's good answers.
func (b *Batch) Exec(ctx context.Context) {
	for _, g := range b.groups {
		_, _ = g.client.Pipelined(ctx, func(p redis.Pipeliner) error {
			for _, fn := range g.queue {
				fn(ctx, p)
			}
			return nil
		})
	}
}

// PackedRead is one queued PackedReader lookup; Entries decodes its answer after Exec.
type PackedRead struct {
	p    *PackedReader
	ids  []int
	ttl  time.Duration
	cmds []*redis.StringCmd
}

// Queue adds the `${key}:${id}` GETs of ids to b, with Get's semantics (see Get). Nothing is queued for
// no ids or no client: every id is then a miss.
func (p *PackedReader) Queue(b *Batch, key string, ids []int, ttl time.Duration) *PackedRead {
	r := &PackedRead{p: p, ids: ids, ttl: ttl}
	if len(ids) == 0 || p.Redis == nil {
		return r
	}
	r.cmds = make([]*redis.StringCmd, len(ids))
	b.add(p.Redis, func(ctx context.Context, pl redis.Pipeliner) {
		for i, id := range ids {
			r.cmds[i] = pl.Get(ctx, p.key(key, id))
		}
	})
	return r
}

// Entries decodes the lookup's answer by id, after the batch's Exec (see Get).
func (r *PackedRead) Entries() map[int]Entry {
	out, _ := r.read()
	return out
}

// read is Entries plus writable: the ids it does not answer whose entry Node's fetch would write
// once its lookup computes it (no key, or an undecodable value); a debounce marker or a failed read
// is not writable. With no client queued, every id is absent. writable is nil when every id is an
// entry (a hit costs no allocation).
func (r *PackedRead) read() (map[int]Entry, map[int]bool) {
	out := make(map[int]Entry, len(r.ids))
	var writable map[int]bool
	if len(r.cmds) == 0 {
		writable = make(map[int]bool, len(r.ids))
		for _, id := range r.ids {
			writable[id] = true
		}
		return out, writable
	}
	now := time.Now()
	if r.p.Now != nil {
		now = r.p.Now()
	}
	for i, cmd := range r.cmds {
		e, st := entryState(cmd, r.ttl, now)
		if st == stateEntry {
			out[r.ids[i]] = e
			continue
		}
		if st == stateAbsent {
			if writable == nil {
				writable = map[int]bool{}
			}
			writable[r.ids[i]] = true
		}
	}
	return out, writable
}

// raw is each id's cached bytes, after the batch's Exec, for the ids whose GET answered a value.
func (r *PackedRead) raw() map[int][]byte {
	out := map[int][]byte{}
	for i, cmd := range r.cmds {
		if b, err := cmd.Bytes(); err == nil {
			out[r.ids[i]] = b
		}
	}
	return out
}

// metricsRead is one queued getImageMetricsObject lookup over the watcher-fed metric hashes: the
// HGETALL of each id's `metrics:Image:<id>`. An image with no hash at all is a miss and falls back
// (the Node path populates it from ClickHouse). Every image whose hash exists is KNOWN, a `notFound`
// marker included: on the direct read getImageMetricsObjectDirect writes `shapeImageMetrics(id,
// metrics[id])` for every requested id, so the id MetricService.fetch skips for the marker gets an
// all-null entry; on the image-metrics-swr read shapeCachedMetricHash shapes the marker hash to nulls.
// Either way toImageV2Stats sees an entry: zero counts, statsUnknown false. (Node reports statsUnknown
// only when the ClickHouse read failed or timed out and the cache held no hash; an image with no hash
// falls back here, so this service never answers statsUnknown true.)
type metricsRead struct {
	ids  []int
	cmds []*redis.MapStringStringCmd
}

// queueMetrics adds the metric HGETALLs of (unique) ids to b, on s.Cache.
func (s *Sources) queueMetrics(b *Batch, ids []int) *metricsRead {
	r := &metricsRead{ids: ids}
	if len(ids) == 0 {
		return r
	}
	r.cmds = make([]*redis.MapStringStringCmd, len(ids))
	b.add(s.Cache, func(ctx context.Context, p redis.Pipeliner) {
		for i, id := range ids {
			r.cmds[i] = p.HGetAll(ctx, metricHashKey(id))
		}
	})
	return r
}

// hashes is the metric hashes after Exec, in id order. The first command error in command order is
// the read failure (an HGETALL answers an absent key with an empty hash, never redis.Nil, so every
// error here is real).
func (r *metricsRead) hashes() ([]map[string]string, error) {
	hashes := make([]map[string]string, len(r.cmds))
	for i, cmd := range r.cmds {
		hash, err := cmd.Result()
		if err != nil {
			return nil, metricsReadFailed(err)
		}
		hashes[i] = hash
	}
	return hashes, nil
}

// metricsResult is getImageMetricsObject over the metrics read after Exec: every id whose hash exists
// is answered from it; the ids with no hash are MetricService.fetch's cold misses, computed from
// ClickHouse (computeMetrics) when s.Compute has a metrics source, else the `metrics-miss` fallback.
func (s *Sources) metricsResult(ctx context.Context, r *metricsRead) (map[int]Metrics, error) {
	if len(r.ids) == 0 {
		return map[int]Metrics{}, nil
	}
	hashes, err := r.hashes()
	if err != nil {
		return nil, err
	}
	out, miss := splitMetricHashes(r.ids, hashes)
	if len(miss) == 0 {
		return out, nil
	}
	if s.Compute == nil || s.Compute.Metrics == nil {
		return nil, fallback.New("metrics-miss")
	}
	computed, err := s.Compute.computeMetrics(ctx, s.Cache, miss)
	if err != nil {
		return nil, err
	}
	for id, m := range computed {
		out[id] = m
	}
	return out, nil
}
