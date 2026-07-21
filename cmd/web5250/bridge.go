package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"

	"web5250/internal/tn5250"
)

// ── Service state / connection limits ───────────────────────────────────

var (
	stateMu    sync.Mutex
	locked     bool
	lockedHost string
	lockedPort string
	hostUseTLS bool

	connectionCount int64
	ipConns         = map[string]int{}

	maxConns       = 100
	maxPerIP       = 10
	maxMessageSize = int64(1 << 20) // 1 MiB
)

func setLock(host, port string) {
	stateMu.Lock()
	locked, lockedHost, lockedPort = true, host, port
	stateMu.Unlock()
}

func setHostTLS(v bool) {
	stateMu.Lock()
	hostUseTLS = v
	stateMu.Unlock()
}

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 65536,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// ── JSON protocol types (browser ⇄ server) ──────────────────────────────
// These mirror web3270's contract so the (adapted) frontend works unchanged,
// minus the IND$FILE file-transfer messages which do not apply to 5250.

// Browser → server.
type wsClientMessage struct {
	Type       string        `json:"type"` // "connect","aid","disconnect","attn"
	Host       string        `json:"host"`
	Port       string        `json:"port"`
	Model      string        `json:"model"`      // "3179-2","3477-FC","custom"
	Codepage   string        `json:"codepage"`   // "37","500",...
	CustomRows int           `json:"customRows"` // for model "custom"
	CustomCols int           `json:"customCols"`
	AID        string        `json:"aid"`    // for "aid": "Enter","PF3","Help",...
	Cursor     *wsCursorPos  `json:"cursor"` // for "aid"
	Fields     []wsFieldData `json:"fields"` // for "aid": modified field data
}

type wsCursorPos struct {
	Row int `json:"row"`
	Col int `json:"col"`
}

type wsFieldData struct {
	Addr int    `json:"addr"` // field start address (first data position)
	Data string `json:"data"` // UTF-8 field content
}

// Server → browser.
type wsScreenMessage struct {
	Type            string        `json:"type"` // "screen"
	Rows            int           `json:"rows"`
	Cols            int           `json:"cols"`
	Cursor          wsCursorPos   `json:"cursor"`
	CursorSet       bool          `json:"cursorSet"`
	Alarm           bool          `json:"alarm,omitempty"`
	KeyboardRestore bool          `json:"kbdRestore,omitempty"`
	MessageWait     bool          `json:"mw,omitempty"`        // host has a message waiting
	ErrorText       string        `json:"errorText,omitempty"` // operator-error text (Write Error Code)
	Cells           []wsCell      `json:"cells"`
	Fields          []wsFieldInfo `json:"fields"`
	// Enhanced (GUI) overlays — absent on ordinary screens.
	Windows    []wsWindow    `json:"windows,omitempty"`
	Selections []wsSelection `json:"selections,omitempty"`
	Scrollbars []wsScrollbar `json:"scrollbars,omitempty"`
}

// wsWindow, wsSelection and wsScrollbar carry the 5250 GUI overlays to the
// browser (see tn5250.SnapWindow / SnapSelectionField / SnapScrollbar).
type wsWindow struct {
	Row    int    `json:"row"`
	Col    int    `json:"col"`
	Width  int    `json:"w"`
	Height int    `json:"h"`
	Border string `json:"border"` // 8 border runes: UL,top,UR,left,right,LL,bottom,LR
}

type wsSelection struct {
	Row   int               `json:"row"`
	Col   int               `json:"col"`
	Type  int               `json:"stype"`
	Items []wsSelectionItem `json:"items"`
}

type wsSelectionItem struct {
	Row       int    `json:"row"`
	Col       int    `json:"col"`
	Text      string `json:"text"`
	Selected  bool   `json:"sel,omitempty"`
	Available bool   `json:"avail,omitempty"`
}

type wsScrollbar struct {
	Row        int  `json:"row"`
	Col        int  `json:"col"`
	Horizontal bool `json:"horiz,omitempty"`
	Total      int  `json:"total"`
	Slider     int  `json:"slider"`
	Size       int  `json:"size"`
}

type wsCell struct {
	Char      string `json:"c"`
	FgColor   string `json:"fg"`
	BgColor   string `json:"bg,omitempty"`
	Highlight string `json:"hi,omitempty"`
	Protected bool   `json:"prot,omitempty"`
	Hidden    bool   `json:"hid,omitempty"`
	Intense   bool   `json:"int,omitempty"`
}

type wsDeltaCell struct {
	Addr      int    `json:"a"`
	Char      string `json:"c"`
	FgColor   string `json:"fg"`
	BgColor   string `json:"bg,omitempty"`
	Highlight string `json:"hi,omitempty"`
	Protected bool   `json:"prot,omitempty"`
	Hidden    bool   `json:"hid,omitempty"`
	Intense   bool   `json:"int,omitempty"`
}

type wsDeltaMessage struct {
	Type            string        `json:"type"` // "delta"
	Rows            int           `json:"rows"`
	Cols            int           `json:"cols"`
	Cursor          wsCursorPos   `json:"cursor"`
	CursorSet       bool          `json:"cursorSet"`
	Alarm           bool          `json:"alarm,omitempty"`
	KeyboardRestore bool          `json:"kbdRestore,omitempty"`
	MessageWait     bool          `json:"mw,omitempty"`
	ErrorText       string        `json:"errorText,omitempty"`
	Delta           []wsDeltaCell `json:"delta"`
	Fields          []wsFieldInfo `json:"fields"`
	// Enhanced (GUI) overlays — absent on ordinary screens.
	Windows    []wsWindow    `json:"windows,omitempty"`
	Selections []wsSelection `json:"selections,omitempty"`
	Scrollbars []wsScrollbar `json:"scrollbars,omitempty"`
}

type wsFieldInfo struct {
	Addr      int  `json:"addr"`
	Length    int  `json:"len"`
	Protected bool `json:"prot"`
	Numeric   bool `json:"num,omitempty"`
	Hidden    bool `json:"hid,omitempty"`
	Autoskip  bool `json:"skip,omitempty"`
	// Field-format detail for faithful local editing (see tn5250.SnapField).
	Type      int  `json:"ftype,omitempty"` // 0-7 FFW type
	AutoEnter bool `json:"auto,omitempty"`
	FER       bool `json:"fer,omitempty"`
	Monocase  bool `json:"mono,omitempty"`
	Mandatory bool `json:"mand,omitempty"`
	DupEnable bool `json:"dup,omitempty"`
	Adjust    int  `json:"adj,omitempty"` // 0/5/6/7 mand-fill/right-adjust
	ID        int  `json:"id,omitempty"`
	NextProg  int  `json:"nextprog,omitempty"`
}

type wsStatusMessage struct {
	Type    string `json:"type"` // "status"
	Status  string `json:"status"`
	Message string `json:"message"`
	Locked  bool   `json:"locked,omitempty"`
	Host    string `json:"host,omitempty"`
	Port    string `json:"port,omitempty"`
	Error   string `json:"errorText,omitempty"` // 5250 error/message row text
}

// ── WebSocket handler ────────────────────────────────────────────────────

func web5250WSHandler(w http.ResponseWriter, r *http.Request) {
	connIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(connIP); err == nil {
		connIP = host
	}

	stateMu.Lock()
	if int(atomic.LoadInt64(&connectionCount)) >= maxConns {
		stateMu.Unlock()
		http.Error(w, "Too many web5250 connections", http.StatusServiceUnavailable)
		return
	}
	if ipConns[connIP] >= maxPerIP {
		stateMu.Unlock()
		http.Error(w, "Too many web5250 connections from this IP", http.StatusTooManyRequests)
		return
	}
	ipConns[connIP]++
	stateMu.Unlock()

	wsConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("web5250 WebSocket upgrade error: %v", err)
		releaseIP(connIP)
		return
	}
	wsConn.SetReadLimit(maxMessageSize)

	atomic.AddInt64(&connectionCount, 1)
	log.Printf("web5250 OPEN %s active=%d", connIP, atomic.LoadInt64(&connectionCount))
	defer func() {
		atomic.AddInt64(&connectionCount, -1)
		log.Printf("web5250 CLOSE %s active=%d", connIP, atomic.LoadInt64(&connectionCount))
		releaseIP(connIP)
	}()

	session := &web5250Session{
		wsConn:   wsConn,
		screenCh: make(chan []byte, 4),
	}
	go session.screenWriter()
	defer session.cleanup()

	stateMu.Lock()
	isLocked := locked
	stateMu.Unlock()
	if isLocked {
		session.sendLockedStatus()
	}

	session.run()
}

func releaseIP(ip string) {
	stateMu.Lock()
	ipConns[ip]--
	if ipConns[ip] <= 0 {
		delete(ipConns, ip)
	}
	stateMu.Unlock()
}

// ── Session ──────────────────────────────────────────────────────────────

type web5250Session struct {
	wsConn   *websocket.Conn
	client   *tn5250.Client
	mu       sync.Mutex // protects client
	wsMu     sync.Mutex // serializes WebSocket writes
	screenMu sync.Mutex // protects prevCells/prevRows/prevCols
	screenCh chan []byte

	prevCells []wsCell
	prevRows  int
	prevCols  int
}

func (s *web5250Session) wsWrite(data []byte) {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	if err := s.wsConn.WriteMessage(websocket.TextMessage, data); err != nil {
		s.wsConn.Close()
	}
}

// screenWriter drains queued frames so the tn5250 read loop is never blocked by
// WebSocket I/O.
func (s *web5250Session) screenWriter() {
	for data := range s.screenCh {
		s.wsWrite(data)
	}
}

func (s *web5250Session) cleanup() {
	s.mu.Lock()
	c := s.client
	s.mu.Unlock()
	if c != nil {
		c.Disconnect()
	}
	close(s.screenCh)
	s.wsConn.Close()
}

func (s *web5250Session) run() {
	for {
		_, msgBytes, err := s.wsConn.ReadMessage()
		if err != nil {
			return
		}
		var msg wsClientMessage
		if err := json.Unmarshal(msgBytes, &msg); err != nil {
			s.sendStatus("error", "Invalid message format")
			continue
		}
		switch msg.Type {
		case "connect":
			s.handleConnect(msg)
		case "aid":
			s.handleAID(msg)
		case "disconnect":
			s.handleDisconnect()
		case "attn":
			s.handleAttn()
		}
	}
}

func (s *web5250Session) handleConnect(msg wsClientMessage) {
	s.handleDisconnect()

	host, port := msg.Host, msg.Port
	stateMu.Lock()
	if locked {
		host, port = lockedHost, lockedPort
	}
	useTLS := hostUseTLS
	stateMu.Unlock()

	if host == "" {
		host = "localhost"
	}
	if port == "" {
		port = "23"
	}
	cp := msg.Codepage
	if cp == "" {
		cp = "37"
	}

	var client *tn5250.Client
	model := msg.Model
	if model == "custom" && msg.CustomRows > 0 && msg.CustomCols > 0 {
		client = tn5250.NewClientCustom(msg.CustomRows, msg.CustomCols, cp)
	} else {
		if model == "" {
			model = "3179-2"
		}
		client = tn5250.NewClient(model, cp)
	}

	client.SetUpdateCallback(func(snap *tn5250.Snapshot) {
		s.sendSnapshot(snap)
	})

	s.sendStatus("status", fmt.Sprintf("Connecting to %s:%s...", host, port))

	if err := client.Connect(host, port, useTLS); err != nil {
		s.sendStatus("error", fmt.Sprintf("Connection failed: %v", err))
		return
	}

	s.mu.Lock()
	s.client = client
	s.mu.Unlock()

	// Show the screen size (never the internal device-type designation).
	s.sendStatus("connected", fmt.Sprintf("Connected to %s:%s (%dx%d)", host, port, client.Rows(), client.Cols()))

	// Read from the AS/400 in the background. Only clear s.client if it still
	// refers to THIS client (guards against a newer handleConnect).
	go func(my *tn5250.Client) {
		err := my.Run()
		s.mu.Lock()
		if s.client == my {
			s.client = nil
		}
		s.mu.Unlock()
		if err != nil {
			s.sendStatus("disconnected", fmt.Sprintf("Connection closed: %v", err))
		} else {
			s.sendStatus("disconnected", "Connection closed")
		}
	}(client)
}

func (s *web5250Session) handleAID(msg wsClientMessage) {
	s.mu.Lock()
	client := s.client
	s.mu.Unlock()
	if client == nil {
		s.sendStatus("error", "Not connected")
		return
	}

	// Attn is a signal, not a data-carrying AID. The frontend routes it through
	// the aid path, so intercept it here and send the 5250 ATTN.
	if msg.AID == "Attn" {
		client.SendAttn()
		return
	}

	row, col := 0, 0
	if msg.Cursor != nil {
		row, col = msg.Cursor.Row, msg.Cursor.Col
	}

	fields := make(map[int]string, len(msg.Fields))
	for _, f := range msg.Fields {
		fields[f.Addr] = f.Data
	}

	if err := client.SendAID(msg.AID, row, col, fields); err != nil {
		s.sendStatus("error", fmt.Sprintf("Send error: %v", err))
	}
}

func (s *web5250Session) handleAttn() {
	s.mu.Lock()
	client := s.client
	s.mu.Unlock()
	if client != nil {
		client.SendAttn()
	}
}

func (s *web5250Session) handleDisconnect() {
	s.mu.Lock()
	client := s.client
	s.client = nil
	s.mu.Unlock()
	if client != nil {
		client.Disconnect()
		s.sendStatus("disconnected", "Disconnected")
	}
}

// ── Snapshot serialization (delta-encoded, x3270-style) ─────────────────

func snapToCells(snap *tn5250.Snapshot) []wsCell {
	cells := make([]wsCell, len(snap.Cells))
	for i := range snap.Cells {
		sc := &snap.Cells[i]
		ch := " "
		if sc.Char != 0 {
			ch = string(sc.Char)
		} else {
			ch = "" // null cell — browser shows blank, tracks as null
		}
		fg := sc.Fg
		if fg == "" {
			fg = "green"
		}
		cells[i] = wsCell{
			Char:      ch,
			FgColor:   fg,
			BgColor:   sc.Bg,
			Highlight: sc.Highlight,
			Protected: sc.Protected,
			Hidden:    sc.Hidden,
			Intense:   sc.Intense,
		}
	}
	return cells
}

// snapGUI converts the Snapshot's enhanced (GUI) overlays into their wire form.
// All three slices stay nil on an ordinary screen, so the JSON fields are omitted.
func snapGUI(snap *tn5250.Snapshot) (windows []wsWindow, selections []wsSelection, scrollbars []wsScrollbar) {
	for _, w := range snap.Windows {
		windows = append(windows, wsWindow{
			Row: w.Row, Col: w.Col, Width: w.Width, Height: w.Height, Border: w.Border,
		})
	}
	for _, s := range snap.Selections {
		out := wsSelection{Row: s.Row, Col: s.Col, Type: s.Type}
		for _, it := range s.Items {
			out.Items = append(out.Items, wsSelectionItem{
				Row: it.Row, Col: it.Col, Text: it.Text,
				Selected: it.Selected, Available: it.Available,
			})
		}
		selections = append(selections, out)
	}
	for _, sb := range snap.Scrollbars {
		scrollbars = append(scrollbars, wsScrollbar{
			Row: sb.Row, Col: sb.Col, Horizontal: sb.Horizontal,
			Total: sb.Total, Slider: sb.Slider, Size: sb.Size,
		})
	}
	return windows, selections, scrollbars
}

func cellsDiffer(a, b *wsCell) bool {
	return a.Char != b.Char || a.FgColor != b.FgColor || a.BgColor != b.BgColor ||
		a.Highlight != b.Highlight || a.Protected != b.Protected ||
		a.Hidden != b.Hidden || a.Intense != b.Intense
}

func (s *web5250Session) sendSnapshot(snap *tn5250.Snapshot) {
	size := len(snap.Cells)
	cells := snapToCells(snap)

	fields := make([]wsFieldInfo, len(snap.Fields))
	for i, f := range snap.Fields {
		fields[i] = wsFieldInfo{
			Addr:      f.Addr,
			Length:    f.Length,
			Protected: f.Protected,
			Numeric:   f.Numeric,
			Hidden:    f.Hidden,
			Autoskip:  f.Autoskip,
			Type:      f.Type,
			AutoEnter: f.AutoEnter,
			FER:       f.FER,
			Monocase:  f.Monocase,
			Mandatory: f.Mandatory,
			DupEnable: f.DupEnable,
			Adjust:    f.Adjust,
			ID:        f.ID,
			NextProg:  f.NextProg,
		}
	}

	windows, selections, scrollbars := snapGUI(snap)

	cursor := wsCursorPos{Row: snap.CursorRow, Col: snap.CursorCol}
	kbdRestore := !snap.KeyboardLocked

	var data []byte
	var err error

	s.screenMu.Lock()
	canDelta := s.prevCells != nil && s.prevRows == snap.Rows &&
		s.prevCols == snap.Cols && len(s.prevCells) == size
	if canDelta {
		delta := make([]wsDeltaCell, 0, 128)
		for i := 0; i < size; i++ {
			if cellsDiffer(&cells[i], &s.prevCells[i]) {
				delta = append(delta, wsDeltaCell{
					Addr:      i,
					Char:      cells[i].Char,
					FgColor:   cells[i].FgColor,
					BgColor:   cells[i].BgColor,
					Highlight: cells[i].Highlight,
					Protected: cells[i].Protected,
					Hidden:    cells[i].Hidden,
					Intense:   cells[i].Intense,
				})
			}
		}
		if len(delta) < size/2 {
			data, err = json.Marshal(wsDeltaMessage{
				Type: "delta", Rows: snap.Rows, Cols: snap.Cols,
				Cursor: cursor, CursorSet: snap.CursorSet, Alarm: snap.Alarm,
				KeyboardRestore: kbdRestore, MessageWait: snap.MessageWait,
				ErrorText: snap.ErrorText, Delta: delta, Fields: fields,
				Windows: windows, Selections: selections, Scrollbars: scrollbars,
			})
		}
	}
	if data == nil {
		data, err = json.Marshal(wsScreenMessage{
			Type: "screen", Rows: snap.Rows, Cols: snap.Cols,
			Cursor: cursor, CursorSet: snap.CursorSet, Alarm: snap.Alarm,
			KeyboardRestore: kbdRestore, MessageWait: snap.MessageWait,
			ErrorText: snap.ErrorText, Cells: cells, Fields: fields,
			Windows: windows, Selections: selections, Scrollbars: scrollbars,
		})
	}
	if err != nil {
		s.screenMu.Unlock()
		return
	}
	s.prevCells = cells
	s.prevRows = snap.Rows
	s.prevCols = snap.Cols
	s.screenMu.Unlock()

	// Non-blocking: drop/replace the queued frame if the browser lags, and
	// invalidate the delta baseline so the next frame is a full send.
	select {
	case s.screenCh <- data:
	default:
		s.screenMu.Lock()
		s.prevCells = nil
		s.screenMu.Unlock()
		select {
		case <-s.screenCh:
		default:
		}
		select {
		case s.screenCh <- data:
		default:
		}
	}
}

func (s *web5250Session) sendStatus(status, message string) {
	data, _ := json.Marshal(wsStatusMessage{Type: "status", Status: status, Message: message})
	s.wsWrite(data)
}

func (s *web5250Session) sendLockedStatus() {
	stateMu.Lock()
	h, p := lockedHost, lockedPort
	stateMu.Unlock()
	data, _ := json.Marshal(wsStatusMessage{
		Type: "status", Status: "locked", Locked: true, Host: h, Port: p,
	})
	s.wsWrite(data)
}
