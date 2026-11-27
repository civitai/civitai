package cache

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeValkey speaks RESP2 for the commands RESP sends, over a real TCP listener, backed by a
// memStore. mode injects a fault into every reply: "garbage", "hang", "close".
type fakeValkey struct {
	ln       net.Listener
	store    *memStore
	password string

	mu       sync.Mutex
	mode     string
	dials    int
	commands []string
	db       string
}

func newFakeValkey(t *testing.T) *fakeValkey {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeValkey{ln: ln, store: newMemStore()}
	go f.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return f
}

func (f *fakeValkey) client() *RESP { return &RESP{Addr: f.ln.Addr().String()} }

func (f *fakeValkey) setMode(m string) { f.mu.Lock(); f.mode = m; f.mu.Unlock() }

func (f *fakeValkey) serve() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			return
		}
		f.mu.Lock()
		f.dials++
		f.mu.Unlock()
		go f.conn(c)
	}
}

func readCommand(rd *bufio.Reader) ([]string, error) {
	line, err := rd.ReadString('\n')
	if err != nil {
		return nil, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(line[1:]))
	if err != nil || line[0] != '*' {
		return nil, errors.New("not an array")
	}
	args := make([]string, n)
	for i := range n {
		hdr, err := rd.ReadString('\n')
		if err != nil {
			return nil, err
		}
		size, _ := strconv.Atoi(strings.TrimSpace(hdr[1:]))
		buf := make([]byte, size+2)
		if _, err := io.ReadFull(rd, buf); err != nil {
			return nil, err
		}
		args[i] = string(buf[:size])
	}
	return args, nil
}

func bulk(b []byte) string { return fmt.Sprintf("$%d\r\n%s\r\n", len(b), b) }

func (f *fakeValkey) conn(c net.Conn) {
	defer func() { _ = c.Close() }()
	rd := bufio.NewReader(c)
	f.mu.Lock()
	password := f.password
	f.mu.Unlock()
	authed := password == ""
	ctx := context.Background()
	for {
		args, err := readCommand(rd)
		if err != nil {
			return
		}
		f.mu.Lock()
		mode := f.mode
		f.commands = append(f.commands, args[0])
		f.mu.Unlock()
		switch mode {
		case "garbage":
			_, _ = io.WriteString(c, "?what\r\n")
			continue
		case "hang":
			time.Sleep(time.Second)
			return
		case "close":
			return
		}
		var out string
		ms := func(s string) time.Duration { n, _ := strconv.Atoi(s); return time.Duration(n) * time.Millisecond }
		switch strings.ToUpper(args[0]) {
		case "AUTH":
			if args[len(args)-1] != password {
				out = "-WRONGPASS invalid password\r\n"
				break
			}
			authed = true
			out = "+OK\r\n"
		case "SELECT":
			f.mu.Lock()
			f.db = args[1]
			f.mu.Unlock()
			out = "+OK\r\n"
		default:
			if !authed {
				out = "-NOAUTH Authentication required.\r\n"
				break
			}
			out = f.exec(ctx, args, ms)
		}
		_, _ = io.WriteString(c, out)
	}
}

func (f *fakeValkey) exec(ctx context.Context, args []string, ms func(string) time.Duration) string {
	st := f.store
	switch strings.ToUpper(args[0]) {
	case "GET":
		v, err := st.Get(ctx, args[1])
		if err != nil {
			return "$-1\r\n"
		}
		return bulk(v)
	case "SET":
		if len(args) == 6 && args[5] == "NX" {
			ok, _ := st.SetNX(ctx, args[1], []byte(args[2]), ms(args[4]))
			if !ok {
				return "$-1\r\n"
			}
			return "+OK\r\n"
		}
		_ = st.Set(ctx, args[1], []byte(args[2]), ms(args[4]))
		return "+OK\r\n"
	case "DEL":
		_ = st.Del(ctx, args[1])
		return ":1\r\n"
	case "HGETALL":
		h, _ := st.HGetAll(ctx, args[1])
		var out strings.Builder
		fmt.Fprintf(&out, "*%d\r\n", 2*len(h))
		for k, v := range h {
			out.WriteString(bulk([]byte(k)) + bulk(v))
		}
		return out.String()
	case "EVAL":
		key := args[3]
		switch args[1] {
		case scriptSwapIf:
			ok, _ := st.SwapIf(ctx, key, []byte(args[4]), []byte(args[5]), ms(args[6]))
			if ok {
				return ":1\r\n"
			}
			return ":0\r\n"
		case scriptDelIf:
			_ = st.DelIf(ctx, key, []byte(args[4]))
			return ":1\r\n"
		case scriptHSet:
			n, _ := strconv.Atoi(args[7])
			_ = st.HSet(ctx, key, args[4], []byte(args[5]), ms(args[6]), n)
			return ":1\r\n"
		}
		return "-ERR unknown script\r\n"
	}
	return "-ERR unknown command\r\n"
}

func ctxT(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	t.Cleanup(cancel)
	return ctx
}

func TestRESPSpeaksEveryCommandCacheUses(t *testing.T) {
	f := newFakeValkey(t)
	r := f.client()
	defer r.Close()
	ctx := ctxT(t)
	if _, err := r.Get(ctx, "k"); !errors.Is(err, ErrMiss) {
		t.Fatalf("get of nothing: %v", err)
	}
	if err := r.Set(ctx, "k", []byte("v\r\nwith CRLF and \x00 bytes"), time.Minute); err != nil {
		t.Fatal(err)
	}
	if v, err := r.Get(ctx, "k"); err != nil || string(v) != "v\r\nwith CRLF and \x00 bytes" {
		t.Fatalf("get: %q %v", v, err)
	}
	if _, ttl := f.store.raw("k"); ttl != time.Minute {
		t.Fatalf("ttl %s", ttl)
	}
	if ok, err := r.SetNX(ctx, "k", []byte("x"), time.Minute); ok || err != nil {
		t.Fatalf("setnx over a value: %v %v", ok, err)
	}
	if ok, err := r.SetNX(ctx, "n", []byte("x"), time.Minute); !ok || err != nil {
		t.Fatalf("setnx: %v %v", ok, err)
	}
	if ok, err := r.SwapIf(ctx, "n", []byte("wrong"), []byte("y"), time.Minute); ok || err != nil {
		t.Fatalf("swap on a mismatch: %v %v", ok, err)
	}
	if ok, err := r.SwapIf(ctx, "n", []byte("x"), []byte("y"), time.Minute); !ok || err != nil {
		t.Fatalf("swap: %v %v", ok, err)
	}
	if err := r.DelIf(ctx, "n", []byte("y")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Get(ctx, "n"); !errors.Is(err, ErrMiss) {
		t.Fatal("delif did not delete")
	}
	if err := r.HSet(ctx, "h", "f", []byte("hv"), time.Minute, 4); err != nil {
		t.Fatal(err)
	}
	if h, err := r.HGetAll(ctx, "h"); err != nil || string(h["f"]) != "hv" || len(h) != 1 {
		t.Fatalf("hgetall: %v %v", h, err)
	}
	if err := r.Del(ctx, "k"); err != nil {
		t.Fatal(err)
	}
	// Every command went over one connection, reused.
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dials != 1 {
		t.Fatalf("%d connections for sequential commands, want 1", f.dials)
	}
}

func TestRESPAuthenticatesAndSelectsOnEveryNewConnection(t *testing.T) {
	f := newFakeValkey(t)
	f.mu.Lock()
	f.password = "valkey-pass"
	f.mu.Unlock()
	r := f.client()
	r.DB = 3
	if err := r.Set(ctxT(t), "k", []byte("v"), time.Minute); err == nil {
		t.Fatal("unauthenticated set succeeded")
	}
	// The unauthenticated connection was kept (a server error leaves it in step): drop it.
	r.Close()
	r.Password = "wrong"
	if err := r.Set(ctxT(t), "k", []byte("v"), time.Minute); err == nil || strings.Contains(err.Error(), "wrong") {
		t.Fatalf("a wrong password: %v", err)
	}
	r.Password, r.Username = "valkey-pass", "app-data"
	if err := r.Set(ctxT(t), "k", []byte("v"), time.Minute); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.db != "3" {
		t.Fatalf("db %q", f.db)
	}
}

// 🔴 FAIL OPEN at the wire: refused, hung, closed and garbled connections are errors bounded by the
// call's deadline, and a broken connection is never reused.
func TestRESPFaultsAreBoundedErrors(t *testing.T) {
	ln, _ := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	_ = ln.Close()
	if _, err := (&RESP{Addr: addr}).Get(ctxT(t), "k"); err == nil || strings.Contains(err.Error(), addr) {
		t.Fatalf("connection refused: %v", err)
	}
	f := newFakeValkey(t)
	r := f.client()
	for _, mode := range []string{"hang", "close", "garbage"} {
		f.setMode(mode)
		start := time.Now()
		if _, err := r.Get(ctxT(t), "k"); err == nil {
			t.Fatalf("%s: no error", mode)
		}
		if d := time.Since(start); d > 600*time.Millisecond {
			t.Fatalf("%s took %s past a 200ms deadline", mode, d)
		}
	}
	f.setMode("")
	f.mu.Lock()
	before := f.dials
	f.mu.Unlock()
	if err := r.Set(ctxT(t), "k", []byte("v"), time.Minute); err != nil {
		t.Fatalf("after the faults: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dials != before+1 {
		t.Fatal("a broken connection was reused")
	}
}

// A server error reply leaves the connection in step: it is reused.
func TestRESPServerErrorKeepsTheConnection(t *testing.T) {
	f := newFakeValkey(t)
	r := f.client()
	if _, err := r.do(ctxT(t), "NOPE"); !strings.Contains(fmt.Sprint(err), "unknown command") {
		t.Fatalf("err %v", err)
	}
	var re RedisError
	if _, err := r.do(ctxT(t), "NOPE"); !errors.As(err, &re) {
		t.Fatalf("not a RedisError: %v", err)
	}
	if err := r.Set(ctxT(t), "k", []byte("v"), time.Minute); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dials != 1 {
		t.Fatalf("%d connections", f.dials)
	}
}

func TestRESPPoolKeepsAtMostMaxIdle(t *testing.T) {
	f := newFakeValkey(t)
	r := f.client()
	r.MaxIdle = 1
	conns := make([]*respConn, 0, 3)
	for range 3 {
		c, err := r.get(ctxT(t))
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c)
	}
	for _, c := range conns {
		r.put(c)
	}
	r.mu.Lock()
	n := len(r.idle)
	r.mu.Unlock()
	if n != 1 {
		t.Fatalf("%d idle, want 1", n)
	}
	r.Close()
	r.MaxIdle = 0
	c, _ := r.get(ctxT(t))
	r.put(c)
	if len(r.idle) != 1 {
		t.Fatal("the default pool kept nothing")
	}
}

func TestReadReplyRejectsWhatIsNotRESP(t *testing.T) {
	cases := map[string]string{
		"no CRLF":        "+OK\n",
		"bad int":        ":x\r\n",
		"bad bulk len":   "$x\r\n",
		"bulk too long":  "$999999999999\r\n",
		"short bulk":     "$5\r\nab",
		"bulk no CRLF":   "$2\r\nabXY",
		"bad array len":  "*x\r\n",
		"short array":    "*2\r\n+OK\r\n",
		"unknown type":   "!x\r\n",
		"too deep":       "*1\r\n*1\r\n*1\r\n*1\r\n*1\r\n+x\r\n",
		"empty":          "",
		"negative array": "*-2\r\n",
	}
	for name, raw := range cases {
		if _, err := readReply(bufio.NewReader(strings.NewReader(raw)), 0); err == nil {
			t.Errorf("%s: read", name)
		}
	}
	ok := map[string]reply{
		"null bulk":      {kind: '$', null: true},
		"null array":     {kind: '*', null: true},
		"nested error":   {kind: '*'},
		"simple":         {kind: '+', str: "OK"},
		"int":            {kind: ':', n: 7},
		"array of bulks": {kind: '*'},
	}
	raws := map[string]string{
		"null bulk": "$-1\r\n", "null array": "*-1\r\n", "nested error": "*1\r\n-ERR x\r\n", "simple": "+OK\r\n",
		"int": ":7\r\n", "array of bulks": "*2\r\n$1\r\na\r\n$0\r\n\r\n",
	}
	for name, want := range ok {
		got, err := readReply(bufio.NewReader(strings.NewReader(raws[name])), 0)
		if err != nil || got.kind != want.kind || got.null != want.null || got.str != want.str || got.n != want.n {
			t.Errorf("%s: %+v %v", name, got, err)
		}
	}
}

func TestRESPRejectsUnexpectedReplies(t *testing.T) {
	if wantOK(reply{kind: ':'}, nil) == nil || wantInt(reply{kind: '+'}, nil) == nil {
		t.Fatal("a wrong reply type was accepted")
	}
	f := newFakeValkey(t)
	r := f.client()
	// HGETALL of a string-valued key answers an error here; the client passes it on.
	if _, err := r.HGetAll(ctxT(t), "k"); err != nil {
		t.Fatalf("hgetall of nothing: %v", err)
	}
}

func TestParseURL(t *testing.T) {
	for raw, want := range map[string]*RESP{
		"redis://valkey.cache.svc":             {Addr: "valkey.cache.svc:6379"},
		"valkey://valkey.cache.svc:7000/2":     {Addr: "valkey.cache.svc:7000", DB: 2},
		"rediss://cache.example.invalid:6380/": {Addr: "cache.example.invalid:6380"},
		"valkeys://cache.example.invalid/0":    {Addr: "cache.example.invalid:6379"},
		"redis://[::1]:6379":                   {Addr: "[::1]:6379"},
	} {
		got, err := ParseURL(raw)
		if err != nil || got.Addr != want.Addr || got.DB != want.DB {
			t.Errorf("%s: %+v %v", raw, got, err)
		}
		if tls := strings.HasPrefix(raw, "rediss") || strings.HasPrefix(raw, "valkeys"); (got.TLS != nil) != tls {
			t.Errorf("%s: TLS %v", raw, got.TLS != nil)
		}
	}
	for _, raw := range []string{"http://h", "redis://", "redis://u:p@h", "redis://h?x=1", "redis://h#f", "redis://h/16",
		"redis://h/x", "::bad"} {
		if _, err := ParseURL(raw); err == nil {
			t.Errorf("%s parsed", raw)
		}
	}
}

func TestRESPOverTLSFailsClosedOnAPlainServer(t *testing.T) {
	f := newFakeValkey(t)
	r, _ := ParseURL("rediss://" + f.ln.Addr().String())
	if err := r.Set(ctxT(t), "k", []byte("v"), time.Minute); err == nil {
		t.Fatal("a TLS client talked to a plain server")
	}
}
