// Copyright 2026 by moshix. All rights reserved.

package main

import "testing"

// TestResolveListeners covers every -listen/-tls-listen/certs combination the
// dual-listener feature defines, including the backward-compatible legacy path
// (certs without -tls-listen => HTTPS on -listen).
func TestResolveListeners(t *testing.T) {
	tests := []struct {
		name      string
		listen    string
		tlsListen string
		useTLS    bool
		wantPlain string
		wantTLS   string
		wantErr   bool
	}{
		{"plain only", ":8050", "", false, ":8050", "", false},
		{"legacy TLS-only on -listen", ":443", "", true, "", ":443", false},
		{"both listeners", ":8050", ":8443", true, ":8050", ":8443", false},
		{"explicit TLS-only", "", ":8443", true, "", ":8443", false},
		{"tls-listen without certs", ":8050", ":8443", false, "", "", true},
		{"no listeners at all", "", "", false, "", "", true},
		{"certs but no address", "", "", true, "", "", true},
		{"same address for both", ":8050", ":8050", true, "", "", true},
	}
	for _, tt := range tests {
		plain, tlsA, err := resolveListeners(tt.listen, tt.tlsListen, tt.useTLS)
		if (err != nil) != tt.wantErr {
			t.Errorf("%s: err = %v, wantErr %v", tt.name, err, tt.wantErr)
			continue
		}
		if err == nil && (plain != tt.wantPlain || tlsA != tt.wantTLS) {
			t.Errorf("%s: got (%q, %q), want (%q, %q)",
				tt.name, plain, tlsA, tt.wantPlain, tt.wantTLS)
		}
	}
}

func TestListenURL(t *testing.T) {
	if got := listenURL("http", ":8050"); got != "http://localhost:8050" {
		t.Errorf("bare port: got %q", got)
	}
	if got := listenURL("https", "0.0.0.0:8443"); got != "https://0.0.0.0:8443" {
		t.Errorf("host form: got %q", got)
	}
}
