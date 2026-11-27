package cache

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RESP is a Store over valkey's wire protocol (RESP2), with a small pool of connections. It is
// deliberately small: the handful of commands Cache needs, each bounded by its context's deadline,
// and a connection that fails in any way is closed, never reused. Nothing is dialled until the first
// command.
type RESP struct {
	// Addr is host:port.
	Addr string
	// TLS, when set, wraps every connection (a rediss:// URL).
	TLS *tls.Config
	// Password, when set, is sent with AUTH on every new connection (Username with it, when set).
	Username, Password string
	// DB, when not 0, is selected on every new connection.
	DB int
	// MaxIdle bounds the idle connections kept; 0 is 8.
	MaxIdle int

	mu   sync.Mutex
	idle []*respConn
}

// ParseURL reads a redis:// or rediss:// URL (valkey:// and valkeys:// too): host, optional port
// (6379), optional /db. Credentials are not read from it (Password).
func ParseURL(raw string) (*RESP, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("cache: the URL does not parse")
	}
	r := &RESP{}
	switch u.Scheme {
	case "redis", "valkey":
	case "rediss", "valkeys":
		r.TLS = &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12}
	default:
		return nil, errors.New("cache: the URL must be redis://, rediss://, valkey:// or valkeys://")
	}
	if u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("cache: the URL must name a host only (no credentials, query or fragment)")
	}
	port := u.Port()
	if port == "" {
		port = "6379"
	}
	r.Addr = net.JoinHostPort(u.Hostname(), port)
	if p := strings.Trim(u.Path, "/"); p != "" {
		db, err := strconv.Atoi(p)
		if err != nil || db < 0 || db > 15 {
			return nil, errors.New("cache: the URL's path must be a database number from 0 to 15")
		}
		r.DB = db
	}
	return r, nil
}

// RedisError is an error reply from the server.
type RedisError string

func (e RedisError) Error() string { return "cache: server error: " + string(e) }

// The scripts: each compares before it writes, in one step on the server.
const (
	scriptSwapIf = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 end return 0`
	scriptDelIf  = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`
	scriptHSet   = `if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) redis.call('PEXPIRE', KEYS[1], ARGV[3]) return 1`
)

func millis(ttl time.Duration) string { return strconv.FormatInt(max(1, ttl.Milliseconds()), 10) }

// Get implements Store.
func (r *RESP) Get(ctx context.Context, key string) ([]byte, error) {
	rep, err := r.do(ctx, "GET", key)
	switch {
	case err != nil:
		return nil, err
	case rep.null:
		return nil, ErrMiss
	case rep.kind != '$':
		return nil, errUnexpected
	}
	return rep.bulk, nil
}

// Set implements Store.
func (r *RESP) Set(ctx context.Context, key string, val []byte, ttl time.Duration) error {
	rep, err := r.do(ctx, "SET", key, string(val), "PX", millis(ttl))
	return wantOK(rep, err)
}

// SetNX implements Store.
func (r *RESP) SetNX(ctx context.Context, key string, val []byte, ttl time.Duration) (bool, error) {
	rep, err := r.do(ctx, "SET", key, string(val), "PX", millis(ttl), "NX")
	switch {
	case err != nil:
		return false, err
	case rep.null:
		return false, nil
	}
	return true, wantOK(rep, nil)
}

// Del implements Store.
func (r *RESP) Del(ctx context.Context, key string) error {
	rep, err := r.do(ctx, "DEL", key)
	return wantInt(rep, err)
}

// SwapIf implements Store.
func (r *RESP) SwapIf(ctx context.Context, key string, expect, val []byte, ttl time.Duration) (bool, error) {
	rep, err := r.do(ctx, "EVAL", scriptSwapIf, "1", key, string(expect), string(val), millis(ttl))
	if err := wantInt(rep, err); err != nil {
		return false, err
	}
	return rep.n == 1, nil
}

// DelIf implements Store.
func (r *RESP) DelIf(ctx context.Context, key string, expect []byte) error {
	rep, err := r.do(ctx, "EVAL", scriptDelIf, "1", key, string(expect))
	return wantInt(rep, err)
}

// HSet implements Store.
func (r *RESP) HSet(ctx context.Context, key, field string, val []byte, ttl time.Duration, maxFields int) error {
	rep, err := r.do(ctx, "EVAL", scriptHSet, "1", key, field, string(val), millis(ttl), strconv.Itoa(maxFields))
	return wantInt(rep, err)
}

// HGetAll implements Store.
func (r *RESP) HGetAll(ctx context.Context, key string) (map[string][]byte, error) {
	rep, err := r.do(ctx, "HGETALL", key)
	switch {
	case err != nil:
		return nil, err
	case rep.kind != '*' || len(rep.arr)%2 != 0:
		return nil, errUnexpected
	}
	out := make(map[string][]byte, len(rep.arr)/2)
	for i := 0; i < len(rep.arr); i += 2 {
		f, v := rep.arr[i], rep.arr[i+1]
		if f.kind != '$' || v.kind != '$' || f.null || v.null {
			return nil, errUnexpected
		}
		out[string(f.bulk)] = v.bulk
	}
	return out, nil
}

var errUnexpected = errors.New("cache: unexpected reply")

func wantOK(rep reply, err error) error {
	switch {
	case err != nil:
		return err
	case rep.kind != '+' || rep.str != "OK":
		return errUnexpected
	}
	return nil
}

func wantInt(rep reply, err error) error {
	switch {
	case err != nil:
		return err
	case rep.kind != ':':
		return errUnexpected
	}
	return nil
}

// Close closes the idle connections.
func (r *RESP) Close() {
	r.mu.Lock()
	idle := r.idle
	r.idle = nil
	r.mu.Unlock()
	for _, c := range idle {
		_ = c.nc.Close()
	}
}

type respConn struct {
	nc net.Conn
	rd *bufio.Reader
	wr *bufio.Writer
}

// do sends one command and reads its reply, on a pooled connection or a new one. A server error is a
// RedisError, and leaves the connection usable; any other failure closes it.
func (r *RESP) do(ctx context.Context, args ...string) (reply, error) {
	c, err := r.get(ctx)
	if err != nil {
		return reply{}, err
	}
	rep, err := c.roundTrip(ctx, args)
	var re RedisError
	if err != nil && !errors.As(err, &re) {
		_ = c.nc.Close()
		return reply{}, err
	}
	r.put(c)
	return rep, err
}

func (r *RESP) get(ctx context.Context) (*respConn, error) {
	r.mu.Lock()
	if n := len(r.idle); n > 0 {
		c := r.idle[n-1]
		r.idle = r.idle[:n-1]
		r.mu.Unlock()
		return c, nil
	}
	r.mu.Unlock()
	return r.dial(ctx)
}

func (r *RESP) put(c *respConn) {
	limit := r.MaxIdle
	if limit <= 0 {
		limit = 8
	}
	r.mu.Lock()
	if len(r.idle) < limit {
		r.idle = append(r.idle, c)
		c = nil
	}
	r.mu.Unlock()
	if c != nil {
		_ = c.nc.Close()
	}
}

func (r *RESP) dial(ctx context.Context) (*respConn, error) {
	var d net.Dialer
	nc, err := d.DialContext(ctx, "tcp", r.Addr)
	if err != nil {
		// The error names the address; callers count it, never log it with a value.
		return nil, errors.New("cache: connect failed")
	}
	if r.TLS != nil {
		tc := tls.Client(nc, r.TLS)
		if err := tc.HandshakeContext(ctx); err != nil {
			_ = nc.Close()
			return nil, errors.New("cache: TLS handshake failed")
		}
		nc = tc
	}
	c := &respConn{nc: nc, rd: bufio.NewReader(nc), wr: bufio.NewWriter(nc)}
	var setup [][]string
	switch {
	case r.Password != "" && r.Username != "":
		setup = append(setup, []string{"AUTH", r.Username, r.Password})
	case r.Password != "":
		setup = append(setup, []string{"AUTH", r.Password})
	}
	if r.DB != 0 {
		setup = append(setup, []string{"SELECT", strconv.Itoa(r.DB)})
	}
	for _, cmd := range setup {
		if err := wantOK(c.roundTrip(ctx, cmd)); err != nil {
			_ = nc.Close()
			// Never the password: AUTH's reply only.
			return nil, fmt.Errorf("cache: %s failed", cmd[0])
		}
	}
	return c, nil
}

func (c *respConn) roundTrip(ctx context.Context, args []string) (reply, error) {
	if dl, ok := ctx.Deadline(); ok {
		_ = c.nc.SetDeadline(dl)
	} else {
		_ = c.nc.SetDeadline(time.Time{})
	}
	_, _ = fmt.Fprintf(c.wr, "*%d\r\n", len(args))
	for _, a := range args {
		_, _ = fmt.Fprintf(c.wr, "$%d\r\n", len(a))
		_, _ = c.wr.WriteString(a)
		_, _ = c.wr.WriteString("\r\n")
	}
	if err := c.wr.Flush(); err != nil {
		return reply{}, err
	}
	return readReply(c.rd, 0)
}

// The bounds of a reply: one bulk string (a snapshot is a few MiB at most) and one array.
const (
	maxBulk  = 256 << 20
	maxArray = 1 << 20
	maxDepth = 4
)

type reply struct {
	kind byte
	str  string
	n    int64
	bulk []byte
	null bool
	arr  []reply
}

func readReply(rd *bufio.Reader, depth int) (reply, error) {
	line, err := rd.ReadString('\n')
	if err != nil {
		return reply{}, err
	}
	if len(line) < 3 || line[len(line)-2] != '\r' {
		return reply{}, errUnexpected
	}
	kind, body := line[0], line[1:len(line)-2]
	switch kind {
	case '+':
		return reply{kind: kind, str: body}, nil
	case '-':
		if depth > 0 {
			// Inside an array: an element, so the rest of the array is still read.
			return reply{kind: kind, str: body}, nil
		}
		return reply{kind: kind}, RedisError(body)
	case ':':
		n, err := strconv.ParseInt(body, 10, 64)
		if err != nil {
			return reply{}, errUnexpected
		}
		return reply{kind: kind, n: n}, nil
	case '$':
		n, err := strconv.Atoi(body)
		switch {
		case err != nil || n < -1 || n > maxBulk:
			return reply{}, errUnexpected
		case n == -1:
			return reply{kind: kind, null: true}, nil
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(rd, buf); err != nil {
			return reply{}, err
		}
		if buf[n] != '\r' || buf[n+1] != '\n' {
			return reply{}, errUnexpected
		}
		return reply{kind: kind, bulk: buf[:n]}, nil
	case '*':
		n, err := strconv.Atoi(body)
		switch {
		case err != nil || n < -1 || n > maxArray || depth >= maxDepth:
			return reply{}, errUnexpected
		case n == -1:
			return reply{kind: kind, null: true}, nil
		}
		arr := make([]reply, 0, min(n, 1024))
		for range n {
			el, err := readReply(rd, depth+1)
			if err != nil {
				return reply{}, err
			}
			arr = append(arr, el)
		}
		return reply{kind: kind, arr: arr}, nil
	}
	return reply{}, errUnexpected
}
