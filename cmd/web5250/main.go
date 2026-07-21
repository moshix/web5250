// Copyright 2026 by moshix. All rights reserved.

// Standalone web5250 terminal client.
// A self-contained binary that provides a browser-based 5250 (AS/400 / IBM i)
// terminal emulator. It bridges a browser UI (served here) to a TN5250E telnet
// session over a WebSocket, with all screen rendering done client-side.
//
// It is the 5250 twin of web3270: same architecture and UI, with the 3270 data
// stream replaced by a pure-Go port of the GNU tn5250 protocol (internal/tn5250).
//
// Usage:  web5250 -listen :8050 -host as400.example.com -port 23
// Build:  go build -o web5250 ./cmd/web5250/
package main

import (
	"crypto/tls"
	"embed"
	"errors"
	"flag"
	"fmt"
	"html"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
)

//go:embed static
var staticFiles embed.FS

// web5250Version is set at build time via -ldflags "-X main.web5250Version=..."
// Falls back to "dev" for ad-hoc builds.
var web5250Version = "1.7"

// model definitions: the -model flag and the frontend dropdown share these
// values. 5250 terminal types map to a screen geometry.
type modelGeom struct {
	rows, cols int
	label      string
}

// models maps the internal device type (used for TN5250E TERMINAL-TYPE
// negotiation) to its screen geometry. The device type is never shown to the
// user — the UI presents only the screen size.
var models = map[string]modelGeom{
	"3179-2":  {24, 80, "24x80"},
	"3477-FC": {27, 132, "27x132"},
}

func main() {
	fmt.Printf("web5250 version %s - copyright by moshix - all rights reserved\n", web5250Version)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: web5250 [-listen :port] [-tls-listen :port] [-host hostname] [-port tn5250port] [-model 24x80|27x132] [-lock] [-host-tls] [-tls-cert file -tls-key file]\n")
		fmt.Fprintf(os.Stderr, "Examples:\n")
		fmt.Fprintf(os.Stderr, "  plain HTTP:   web5250 -listen :8050 -host as400.example.com -port 23\n")
		fmt.Fprintf(os.Stderr, "  TLS only:     web5250 -listen :443 -tls-cert cert.pem -tls-key key.pem\n")
		fmt.Fprintf(os.Stderr, "  HTTP + HTTPS: web5250 -listen :8050 -tls-listen :8443 -tls-cert cert.pem -tls-key key.pem\n")
	}
	listen := flag.String("listen", ":8050", "Plain-HTTP listen address (\"\" disables; becomes HTTPS if certs are given without -tls-listen)")
	tlsListen := flag.String("tls-listen", "", "HTTPS listen address (requires -tls-cert and -tls-key); when set, -listen stays plain HTTP")
	defaultHost := flag.String("host", "localhost", "Default TN5250 host")
	defaultPort := flag.String("port", "23", "Default TN5250 port (23 plain, 992 TLS)")
	model := flag.String("model", "24x80", "Screen size: 24x80 or 27x132")
	lock := flag.Bool("lock", false, "Lock host/port — users cannot change the connection target")
	hostTLS := flag.Bool("host-tls", false, "Connect to the AS/400 host over TLS (use with -port 992)")
	tlsCert := flag.String("tls-cert", "", "TLS certificate file for the HTTPS listener (enables HTTPS)")
	tlsKey := flag.String("tls-key", "", "TLS private key file (requires -tls-cert)")
	flag.Parse()

	if flag.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "web5250: unknown argument %q\n", flag.Arg(0))
		flag.Usage()
		os.Exit(1)
	}

	// Accept the screen size directly; it maps to the internal 5250 device type
	// used for TERMINAL-TYPE negotiation (never shown to the user).
	switch *model {
	case "24x80", "24X80":
		*model = "3179-2"
	case "27x132", "27X132":
		*model = "3477-FC"
	}
	geom, ok := models[*model]
	if !ok {
		log.Fatalf("web5250: invalid screen size %q — must be 24x80 or 27x132", *model)
	}

	if *lock {
		setLock(*defaultHost, *defaultPort)
	}
	setHostTLS(*hostTLS)

	// Validate HTTPS listener TLS configuration
	useTLS := *tlsCert != "" || *tlsKey != ""
	if useTLS {
		if *tlsCert == "" || *tlsKey == "" {
			log.Fatal("web5250: both -tls-cert and -tls-key must be specified together")
		}
		if _, err := os.Stat(*tlsCert); os.IsNotExist(err) {
			log.Fatalf("web5250: certificate file not found: %s", *tlsCert)
		}
		if _, err := os.Stat(*tlsKey); os.IsNotExist(err) {
			log.Fatalf("web5250: key file not found: %s", *tlsKey)
		}
		if _, err := tls.LoadX509KeyPair(*tlsCert, *tlsKey); err != nil {
			log.Fatalf("web5250: invalid TLS certificate/key: %v", err)
		}
		log.Printf("web5250 HTTPS certificate loaded (%s)", *tlsCert)
	}

	plainAddr, tlsAddr, err := resolveListeners(*listen, *tlsListen, useTLS)
	if err != nil {
		log.Fatalf("web5250: %v", err)
	}

	// Bind both addresses up front so a bad or busy port fails fast with a clear
	// message (and the later "listening" log lines are truthful). This also
	// catches collisions the string check in resolveListeners can't see, like
	// ":8050" vs "0.0.0.0:8050".
	var plainLn, tlsLn net.Listener
	if plainAddr != "" {
		if plainLn, err = net.Listen("tcp", plainAddr); err != nil {
			log.Fatalf("web5250: cannot listen on %s: %v", plainAddr, err)
		}
	}
	if tlsAddr != "" {
		if tlsLn, err = net.Listen("tcp", tlsAddr); err != nil {
			log.Fatalf("web5250: cannot listen on %s: %v", tlsAddr, err)
		}
	}

	// Serve embedded static files
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal(err)
	}

	isLocked := *lock

	mux := http.NewServeMux()

	// Root redirects to the terminal page
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, "/web5250", http.StatusFound)
	})

	// Terminal page — inject default host/port/model into the served HTML.
	mux.HandleFunc("/web5250", func(w http.ResponseWriter, r *http.Request) {
		data, err := staticFiles.ReadFile("static/web5250/index.html")
		if err != nil {
			http.Error(w, "Terminal page not found", 500)
			return
		}
		q := r.URL.Query()
		host := q.Get("host")
		if host == "" {
			host = *defaultHost
		}
		port := q.Get("port")
		if port == "" {
			port = *defaultPort
		}

		page := string(data)
		// Replace the static default values (escape to prevent XSS).
		page = strings.Replace(page, `value="localhost"`, fmt.Sprintf(`value="%s"`, html.EscapeString(host)), 1)
		page = strings.Replace(page, `value="23"`, fmt.Sprintf(`value="%s"`, html.EscapeString(port)), 1)

		// Inject config as JS globals before </head>.
		vars := fmt.Sprintf("var WEB5250_VERSION=%q, WEB5250_MODEL=%q;", web5250Version, *model)
		if isLocked {
			vars += fmt.Sprintf(" var WEB5250_LOCKED_HOST=%q, WEB5250_LOCKED_PORT=%q;",
				html.EscapeString(host), html.EscapeString(port))
		}
		page = strings.Replace(page, "</head>", "<script>"+vars+"</script>\n</head>", 1)

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(page))
	})

	// WebSocket endpoint
	mux.HandleFunc("/web5250/ws", web5250WSHandler)

	// Static assets (CSS, JS, favicon)
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

	if plainLn != nil {
		log.Printf("web5250 listening on %s (http)", plainAddr)
		log.Printf("web5250 open %s in your browser", listenURL("http", plainAddr))
	}
	if tlsLn != nil {
		log.Printf("web5250 listening on %s (https)", tlsAddr)
		log.Printf("web5250 open %s in your browser", listenURL("https", tlsAddr))
	}
	log.Printf("web5250 screen size: %s", geom.label)
	log.Printf("web5250 default connection: %s:%s (host TLS: %v)", *defaultHost, *defaultPort, *hostTLS)
	if isLocked {
		log.Printf("web5250 running locked to %s:%s", *defaultHost, *defaultPort)
	}

	// Serve the already-bound listeners over the same mux; the first one to fail
	// takes the process down, as before. The channel buffer of 2 guarantees
	// neither goroutine can block on send.
	errCh := make(chan error, 2)
	if plainLn != nil {
		go func() { errCh <- http.Serve(plainLn, mux) }()
	}
	if tlsLn != nil {
		go func() { errCh <- http.ServeTLS(tlsLn, mux, *tlsCert, *tlsKey) }()
	}
	log.Fatal(<-errCh)
}

// resolveListeners maps the flag combination to the plain-HTTP and HTTPS listen
// addresses. Backward compatible: certificates WITHOUT -tls-listen serve HTTPS
// on the -listen address (the historical single-listener behavior); with
// -tls-listen, HTTPS runs there and -listen (if non-empty) stays plain HTTP.
func resolveListeners(listen, tlsListen string, useTLS bool) (plainAddr, tlsAddr string, err error) {
	switch {
	case tlsListen != "" && !useTLS:
		return "", "", errors.New("-tls-listen requires -tls-cert and -tls-key")
	case useTLS && tlsListen == "":
		tlsAddr = listen // legacy TLS-only on -listen
	case useTLS:
		tlsAddr = tlsListen
		plainAddr = listen
	default:
		plainAddr = listen
	}
	if plainAddr == "" && tlsAddr == "" {
		if useTLS {
			return "", "", errors.New("TLS certificates given but no listen address; set -listen or -tls-listen")
		}
		return "", "", errors.New("no listeners configured (empty -listen and no -tls-listen)")
	}
	if plainAddr != "" && plainAddr == tlsAddr {
		return "", "", fmt.Errorf("-listen and -tls-listen cannot share the same address %q", plainAddr)
	}
	return plainAddr, tlsAddr, nil
}

// listenURL renders a browser URL for a listen address: a bare ":port" gains a
// localhost host; explicit host:port forms are shown as-is.
func listenURL(scheme, addr string) string {
	if strings.HasPrefix(addr, ":") {
		return scheme + "://localhost" + addr
	}
	return scheme + "://" + addr
}
