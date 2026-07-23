# A browser-based IBM 5250 terminal to connect to OS/400 systems


## Instructions
obtain the binary you need and then launch it from your shell like this:
      
./web5250 -listen :9000 -host pub400.com -port 23
  
Now connect your browser to localhost:9000, or whatever IP you have this running on.

That's it. 

## Command-line switches

| Switch | Default | Description |
|--------|---------|-------------|
| `-listen` | `:8050` | Plain-HTTP listen address. `""` disables it. Becomes HTTPS if `-tls-cert`/`-tls-key` are given without `-tls-listen`. |
| `-tls-listen` | *(off)* | HTTPS listen address (requires `-tls-cert` and `-tls-key`). When set, `-listen` stays plain HTTP, so HTTP and HTTPS run at the same time. |
| `-tls-cert` | *(none)* | TLS certificate file for the HTTPS listener. |
| `-tls-key` | *(none)* | TLS private key file (requires `-tls-cert`). |
| `-host` | `localhost` | Default AS/400 (TN5250) host, pre-filled in the browser UI. |
| `-port` | `23` | Default TN5250 port (23 plain, 992 for TLS). |
| `-host-tls` | `false` | Connect to the AS/400 host over TLS (use with `-port 992`). |
| `-model` | `24x80` | Screen size: `24x80`  or `27x132`. |
| `-device` | *(none)* | TN5250E device name (NEW-ENVIRON `DEVNAME`) to bind a specific virtual device. Empty lets the host auto-assign one. |
| `-kbdtype` | `USB` | NEW-ENVIRON `KBDTYPE` keyboard identifier (e.g. `USB` US-English, `AGB` German). Set it to match your national code page. |
| `-lock` | `false` | Lock the connection target to `-host`/`-port` — the browser fields are disabled and cannot be changed. |

Run `web5250 -h` for a usage summary with examples.

## TLS (HTTPS)

The web UI can be served over TLS. Point `-tls-cert` / `-tls-key` at your
certificate and key files:

HTTPS only (TLS on the `-listen` port):

    ./web5250 -listen :443 -tls-cert cert.pem -tls-key key.pem

HTTP and HTTPS at the same time, each on its own port:

    ./web5250 -listen :9000 -tls-listen :9443 -tls-cert cert.pem -tls-key key.pem

HTTPS only on a dedicated port (disable the plain listener):

    ./web5250 -listen "" -tls-listen :9443 -tls-cert cert.pem -tls-key key.pem

To encrypt the connection to the AS/400 itself, use `-host-tls` (typically with
`-port 992`).

copyright 2026 by moshix, all rights reserved

## Screenshot

<img src="screenshot.png" alt="web5250 terminal screenshot" width="640">
