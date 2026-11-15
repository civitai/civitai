// Package testkit holds hermetic fakes shared by the unit and golden tests: an in-memory Redis that
// answers the handful of commands this service sends, and pgx.Rows over literal values. Only tests
// import it; the binary never does.
package testkit

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Redis is an in-memory redis.UniversalClient for the commands this service sends: GET, HGET,
// HGETALL, SET, SET NX, DEL, SADD and EVAL of a registered script (Scripts), directly or in a
// pipeline. Any other command panics (the embedded nil
// interface), so a test never passes on a command the fake silently ignored.
//
// Failure modes: Err makes every command fail with it (a transport failure); KeyErr, when it returns
// an error for a key, fails only the commands on that key with it (one shard of a cluster down, the
// rest of the pipeline answering); Delay holds every call (direct or pipelined) for that long or until
// the context ends, whichever is first, and a context that ends first fails the call with the
// context's error (a slow store under a deadline).
type Redis struct {
	redis.UniversalClient

	mu      sync.Mutex
	strings map[string][]byte
	hashes  map[string]map[string]string
	sets    map[string]map[string]bool
	ttls    map[string]time.Duration

	Err    error
	KeyErr func(key string) error
	Delay  time.Duration

	// Calls counts round trips (one per direct command, one per Pipelined call).
	Calls int

	// Scripts emulates EVAL, by the script's exact text (see Script).
	Scripts map[string]Script
}

// NewRedis returns an empty fake.
func NewRedis() *Redis {
	return &Redis{
		strings: map[string][]byte{},
		hashes:  map[string]map[string]string{},
		sets:    map[string]map[string]bool{},
		ttls:    map[string]time.Duration{},
	}
}

// SetString stores a string value.
func (r *Redis) SetString(key string, val []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.strings[key] = append([]byte(nil), val...)
}

// SetHash stores a hash.
func (r *Redis) SetHash(key string, fields map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := make(map[string]string, len(fields))
	for k, v := range fields {
		h[k] = v
	}
	r.hashes[key] = h
}

// String returns a stored string value and whether it exists.
func (r *Redis) String(key string) ([]byte, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.strings[key]
	return v, ok
}

// Expiry returns the expiry a SET gave key (0 = none or absent). (Not TTL: that name belongs to the
// embedded client interface.)
func (r *Redis) Expiry(key string) time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ttls[key]
}

// Members returns a set's members, sorted.
func (r *Redis) Members(key string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.sets[key]))
	for m := range r.sets[key] {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// AllKeys returns every key holding a value of any type, sorted. (Not KEYS: that name belongs to the
// embedded client interface.)
func (r *Redis) AllKeys() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.strings)+len(r.hashes)+len(r.sets))
	for k := range r.strings {
		out = append(out, k)
	}
	for k := range r.hashes {
		out = append(out, k)
	}
	for k := range r.sets {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// wait applies Delay and the context; a non-nil error fails the call.
func (r *Redis) wait(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if r.Delay > 0 {
		t := time.NewTimer(r.Delay)
		defer t.Stop()
		select {
		case <-t.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return r.Err
}

// keyErr is KeyErr's verdict on key (nil = the command runs).
func (r *Redis) keyErr(key string) error {
	if r.KeyErr == nil {
		return nil
	}
	return r.KeyErr(key)
}

func (r *Redis) get(key string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if v, ok := r.strings[key]; ok {
		return string(v), nil
	}
	return "", redis.Nil
}

func (r *Redis) hget(key, field string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if v, ok := r.hashes[key][field]; ok {
		return v, nil
	}
	return "", redis.Nil
}

func (r *Redis) hgetall(key string) map[string]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]string{}
	for k, v := range r.hashes[key] {
		out[k] = v
	}
	return out
}

func (r *Redis) set(key string, val any, ttl time.Duration) {
	var b []byte
	switch t := val.(type) {
	case []byte:
		b = append([]byte(nil), t...)
	case string:
		b = []byte(t)
	default:
		panic("testkit.Redis: SET of an unsupported value type")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.strings[key] = b
	r.ttls[key] = ttl
}

func (r *Redis) sadd(key string, members ...any) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sets[key]
	if s == nil {
		s = map[string]bool{}
		r.sets[key] = s
	}
	var n int64
	for _, m := range members {
		v, ok := m.(string)
		if !ok {
			panic("testkit.Redis: SADD of a non-string member")
		}
		if !s[v] {
			s[v] = true
			n++
		}
	}
	return n
}

func (r *Redis) count() {
	r.mu.Lock()
	r.Calls++
	r.mu.Unlock()
}

// Get is GET.
func (r *Redis) Get(ctx context.Context, key string) *redis.StringCmd {
	r.count()
	if err := r.wait(ctx); err != nil {
		return redis.NewStringResult("", err)
	}
	if err := r.keyErr(key); err != nil {
		return redis.NewStringResult("", err)
	}
	return redis.NewStringResult(r.get(key))
}

// HGet is HGET.
func (r *Redis) HGet(ctx context.Context, key, field string) *redis.StringCmd {
	r.count()
	if err := r.wait(ctx); err != nil {
		return redis.NewStringResult("", err)
	}
	if err := r.keyErr(key); err != nil {
		return redis.NewStringResult("", err)
	}
	return redis.NewStringResult(r.hget(key, field))
}

// Pipelined runs fn against a pipeline whose commands all answer at once, as one round trip. Like
// go-redis it returns the first command error (redis.Nil included).
func (r *Redis) Pipelined(ctx context.Context, fn func(redis.Pipeliner) error) ([]redis.Cmder, error) {
	r.count()
	p := &pipe{r: r, ctx: ctx}
	if err := fn(p); err != nil {
		return nil, err
	}
	failErr := r.wait(ctx)
	for _, op := range p.ops {
		op(failErr)
	}
	var first error
	for _, c := range p.cmds {
		if err := c.Err(); err != nil && first == nil {
			first = err
		}
	}
	return p.cmds, first
}

// pipe queues commands; their results are filled in when Pipelined executes them.
type pipe struct {
	redis.Pipeliner
	r    *Redis
	ctx  context.Context
	cmds []redis.Cmder
	ops  []func(failErr error)
}

func (p *pipe) Get(ctx context.Context, key string) *redis.StringCmd {
	cmd := redis.NewStringCmd(ctx, "get", key)
	p.cmds = append(p.cmds, cmd)
	p.ops = append(p.ops, func(failErr error) {
		if failErr == nil {
			failErr = p.r.keyErr(key)
		}
		if failErr != nil {
			cmd.SetErr(failErr)
			return
		}
		v, err := p.r.get(key)
		cmd.SetVal(v)
		cmd.SetErr(err)
	})
	return cmd
}

func (p *pipe) HGet(ctx context.Context, key, field string) *redis.StringCmd {
	cmd := redis.NewStringCmd(ctx, "hget", key, field)
	p.cmds = append(p.cmds, cmd)
	p.ops = append(p.ops, func(failErr error) {
		if failErr == nil {
			failErr = p.r.keyErr(key)
		}
		if failErr != nil {
			cmd.SetErr(failErr)
			return
		}
		v, err := p.r.hget(key, field)
		cmd.SetVal(v)
		cmd.SetErr(err)
	})
	return cmd
}

func (p *pipe) HGetAll(ctx context.Context, key string) *redis.MapStringStringCmd {
	cmd := redis.NewMapStringStringCmd(ctx, "hgetall", key)
	p.cmds = append(p.cmds, cmd)
	p.ops = append(p.ops, func(failErr error) {
		if failErr == nil {
			failErr = p.r.keyErr(key)
		}
		if failErr != nil {
			cmd.SetErr(failErr)
			return
		}
		cmd.SetVal(p.r.hgetall(key))
	})
	return cmd
}

func (p *pipe) Set(ctx context.Context, key string, val any, ttl time.Duration) *redis.StatusCmd {
	cmd := redis.NewStatusCmd(ctx, "set", key)
	p.cmds = append(p.cmds, cmd)
	p.ops = append(p.ops, func(failErr error) {
		if failErr == nil {
			failErr = p.r.keyErr(key)
		}
		if failErr != nil {
			cmd.SetErr(failErr)
			return
		}
		p.r.set(key, val, ttl)
		cmd.SetVal("OK")
	})
	return cmd
}

func (p *pipe) SAdd(ctx context.Context, key string, members ...any) *redis.IntCmd {
	cmd := redis.NewIntCmd(ctx, "sadd", key)
	p.cmds = append(p.cmds, cmd)
	p.ops = append(p.ops, func(failErr error) {
		if failErr == nil {
			failErr = p.r.keyErr(key)
		}
		if failErr != nil {
			cmd.SetErr(failErr)
			return
		}
		cmd.SetVal(p.r.sadd(key, members...))
	})
	return cmd
}

// setNX is SET NX with an expiry: false (and nothing written) when key holds a value of any type.
func (r *Redis) setNX(key string, val any, ttl time.Duration) bool {
	r.mu.Lock()
	_, s := r.strings[key]
	_, h := r.hashes[key]
	_, m := r.sets[key]
	r.mu.Unlock()
	if s || h || m {
		return false
	}
	r.set(key, val, ttl)
	return true
}

func (r *Redis) del(key string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n int64
	if _, ok := r.strings[key]; ok {
		n = 1
	}
	if _, ok := r.hashes[key]; ok {
		n = 1
	}
	if _, ok := r.sets[key]; ok {
		n = 1
	}
	delete(r.strings, key)
	delete(r.hashes, key)
	delete(r.sets, key)
	delete(r.ttls, key)
	return n
}

// Has reports whether key holds a value of any type.
func (r *Redis) Has(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, s := r.strings[key]
	_, h := r.hashes[key]
	_, m := r.sets[key]
	return s || h || m
}

// Hash returns a stored hash (nil when absent).
func (r *Redis) Hash(key string) map[string]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.hashes[key] == nil {
		return nil
	}
	out := map[string]string{}
	for k, v := range r.hashes[key] {
		out[k] = v
	}
	return out
}

// ReplaceHash is the effect of hReplaceStampedEx (event-engine-common/utils/query-utils.ts) on the
// fake: key is deleted, then holds fields, and expires after ttl. For a Script emulator.
func (r *Redis) ReplaceHash(key string, fields map[string]string, ttl time.Duration) {
	r.del(key)
	r.SetHash(key, fields)
	r.mu.Lock()
	r.ttls[key] = ttl
	r.mu.Unlock()
}

// Script emulates one Lua script on the fake: EVAL of a script registered in Redis.Scripts runs its
// emulator; any other script panics.
type Script func(r *Redis, keys []string, args []any) (any, error)

// HReplaceStampedEx emulates event-engine-common's hReplaceStampedEx script: DEL KEYS[1]; stamp
// ARGV[2] with ARGV[3], or ARGV[4] while KEYS[2] exists; HSET the stamp and ARGV[5..] pairs; EXPIRE
// ARGV[1] seconds. Arguments are strings, as go-redis sends them.
func HReplaceStampedEx(r *Redis, keys []string, args []any) (any, error) {
	if len(keys) != 2 || len(args) < 4 || len(args)%2 != 0 {
		return nil, errors.New("testkit: hReplaceStampedEx: wrong arity")
	}
	str := func(v any) string { s, _ := v.(string); return s }
	secs, err := time.ParseDuration(str(args[0]) + "s")
	if err != nil {
		return nil, err
	}
	stamp := str(args[2])
	if r.Has(keys[1]) {
		stamp = str(args[3])
	}
	fields := map[string]string{str(args[1]): stamp}
	for i := 4; i < len(args); i += 2 {
		fields[str(args[i])] = str(args[i+1])
	}
	r.ReplaceHash(keys[0], fields, secs)
	return int64(1), nil
}

func (p *pipe) SetNX(ctx context.Context, key string, val any, ttl time.Duration) *redis.BoolCmd {
	cmd := redis.NewBoolCmd(ctx, "set", key, "nx")
	p.cmds = append(p.cmds, cmd)
	p.ops = append(p.ops, func(failErr error) {
		if failErr == nil {
			failErr = p.r.keyErr(key)
		}
		if failErr != nil {
			cmd.SetErr(failErr)
			return
		}
		cmd.SetVal(p.r.setNX(key, val, ttl))
	})
	return cmd
}

func (p *pipe) Del(ctx context.Context, keys ...string) *redis.IntCmd {
	cmd := redis.NewIntCmd(ctx, "del")
	p.cmds = append(p.cmds, cmd)
	p.ops = append(p.ops, func(failErr error) {
		for _, key := range keys {
			if failErr == nil {
				failErr = p.r.keyErr(key)
			}
		}
		if failErr != nil {
			cmd.SetErr(failErr)
			return
		}
		var n int64
		for _, key := range keys {
			n += p.r.del(key)
		}
		cmd.SetVal(n)
	})
	return cmd
}

func (p *pipe) Eval(ctx context.Context, script string, keys []string, args ...any) *redis.Cmd {
	cmd := redis.NewCmd(ctx, "eval")
	p.cmds = append(p.cmds, cmd)
	emulate, ok := p.r.Scripts[script]
	if !ok {
		panic("testkit.Redis: EVAL of a script no emulator is registered for")
	}
	p.ops = append(p.ops, func(failErr error) {
		if failErr == nil && len(keys) > 0 {
			failErr = p.r.keyErr(keys[0])
		}
		if failErr != nil {
			cmd.SetErr(failErr)
			return
		}
		v, err := emulate(p.r, keys, args)
		cmd.SetVal(v)
		cmd.SetErr(err)
	})
	return cmd
}

// ErrDown is a stand-in transport failure.
var ErrDown = errors.New("testkit: redis is down")
