// web5250 terminal emulator — browser-side 5250 rendering,
// field editing, keyboard handling, and WebSocket communication.

"use strict";

// ── State ───────────────────────────────────────────────────────────

let ws = null;
let connected = false;
let rows = 24, cols = 80;   // 5250 default: 3179-2 (24×80)
let cells = [];       // flat array of cell data from server
let fields = [];      // field metadata from server
// Enhanced (GUI) overlays sent by the host: 5250 windows, selection fields and
// scroll bars. Empty on ordinary screens; drawn on top of the grid by
// renderGuiOverlay() without touching cells[] (see the server's gui.go).
let guiWindows = [];
let guiSelections = [];
let guiScrollbars = [];
let cursorAddr = 0;
let insertMode = false;
let fieldMDT = {};    // addr → bool: tracks which fields were modified
let pendingRender = false; // true if a rAF is scheduled for screen render
let kbdLocked = false;    // true while waiting for host response (keyboard lock)
let ferActive = false;    // field-exit-required inhibit: set when a FER field fills; blocks data keys until Field Exit / Field± / arrow / Reset (mirrors display.c do_key FER handling)
let kbdInhibit = false;   // operator-error input inhibit ("X II"): persists until Reset, matching tn5250 (an operator error locks data entry until Error-Reset)
let operatorErrMsg = "";  // the specific local operator-error text shown in the OIA while kbdInhibit is set (e.g. "X Protected")
// Host-driven OIA indicator bits, updated from each screen/delta frame.
let hostMW = false;       // message waiting (MW)
let hostXSystem = false;  // host X SYSTEM
let hostXClock = false;   // host X CLOCK
let hostInhibit = false;  // host input inhibit -> X II (e.g. Write Error Code)
let shiftHeld = false;    // a Shift key is currently held
let capsLock = false;     // Caps/Shift lock is on
let lastHostCursor = -1;  // last cursor address the host set — used to suppress redundant cursor moves
let autoReconnect = false; // auto-reconnect on disconnect
let reconnectTimer = null; // pending reconnect timeout

// ── Color themes ────────────────────────────────────────────────────
// Each theme maps 5250 logical colors to CSS hex values.
// Background applies to terminal and terminal-container.

const THEMES = {
    "tn5250E": {
        label: "tn5250E",
        bg: "#000000",
        green: "#00c000", blue: "#7890f0", red: "#f07070",
        pink: "#ff00ff", turquoise: "#00e0e0", yellow: "#e0e000",
        white: "#ffffff", defaultColor: "#00c000"
    },
    "Green": {
        label: "Green Screen",
        bg: "#001100",
        green: "#00bb00", blue: "#009900", red: "#007700",
        pink: "#00bb00", turquoise: "#005500", yellow: "#007700",
        white: "#00ff00", defaultColor: "#00bb00"
    }
};

let currentTheme = "tn5250E";
let themeStyleEl = null;

function applyTheme(name) {
    const t = THEMES[name];
    if (!t) return;
    currentTheme = name;

    if (!themeStyleEl) {
        themeStyleEl = document.createElement("style");
        document.head.appendChild(themeStyleEl);
    }

    themeStyleEl.textContent = `
        #terminal-container { background: ${t.bg}; }
        #terminal { background: ${t.bg}; }
        .c-green     { color: ${t.green}; }
        .c-blue      { color: ${t.blue}; }
        .c-red       { color: ${t.red}; }
        .c-pink      { color: ${t.pink}; }
        .c-turquoise { color: ${t.turquoise}; }
        .c-yellow    { color: ${t.yellow}; }
        .c-white     { color: ${t.white}; }
        .c-default   { color: ${t.defaultColor}; }
        .h-reverse.c-green     { background: ${t.green}; color: ${t.bg} !important; }
        .h-reverse.c-blue      { background: ${t.blue}; color: ${t.bg} !important; }
        .h-reverse.c-red       { background: ${t.red}; color: ${t.bg} !important; }
        .h-reverse.c-pink      { background: ${t.pink}; color: ${t.bg} !important; }
        .h-reverse.c-turquoise { background: ${t.turquoise}; color: ${t.bg} !important; }
        .h-reverse.c-yellow    { background: ${t.yellow}; color: ${t.bg} !important; }
        .h-reverse.c-white     { background: ${t.white}; color: ${t.bg} !important; }
        .bg-green     { background-color: ${t.green}; }
        .bg-blue      { background-color: ${t.blue}; }
        .bg-red       { background-color: ${t.red}; }
        .bg-pink      { background-color: ${t.pink}; }
        .bg-turquoise { background-color: ${t.turquoise}; }
        .bg-yellow    { background-color: ${t.yellow}; }
        .bg-white     { background-color: ${t.white}; }
        .bg-default   { background-color: transparent; }
        #terminal span.cursor  { background: ${t.white}; color: ${t.bg}; }
        #terminal span.cursor.h-reverse { background: ${t.bg}; color: ${t.white}; }
        @keyframes blink-cursor {
            0%, 100% { background: ${t.white}; color: ${t.bg}; }
            50%      { background: transparent; color: inherit; }
        }
    `;

    // Update theme button active states
    document.querySelectorAll(".theme-btn").forEach(function(btn) {
        btn.classList.toggle("active", btn.dataset.theme === name);
    });

    // Persist last — never let a storage failure abort the CSS injection above
    try { localStorage.setItem("web5250-theme", name); } catch (e) {}
}

function buildThemeList() {
    const list = document.getElementById("theme-list");
    if (!list) return;
    list.innerHTML = "";
    for (const [name, t] of Object.entries(THEMES)) {
        const btn = document.createElement("button");
        btn.className = "theme-btn" + (name === currentTheme ? " active" : "");
        btn.dataset.theme = name;
        btn.style.background = t.bg;
        btn.style.color = t.green;
        btn.textContent = t.label;
        btn.onclick = function() { applyTheme(name); };
        list.appendChild(btn);
    }
}

// ── Default keyboard mapping ────────────────────────────────────────

const DEFAULT_KEYMAP = {
    "Enter":       "Enter",
    "F1":          "PF1",  "F2":  "PF2",  "F3":  "PF3",
    "F4":          "PF4",  "F5":  "PF5",  "F6":  "PF6",
    "F7":          "PF7",  "F8":  "PF8",  "F9":  "PF9",
    "F10":         "PF10", "F11": "PF11", "F12": "PF12",
    "Shift+F1":    "PF13", "Shift+F2": "PF14", "Shift+F3": "PF15",
    "Shift+F4":    "PF16", "Shift+F5": "PF17", "Shift+F6": "PF18",
    "Shift+F7":    "PF19", "Shift+F8": "PF20", "Shift+F9": "PF21",
    "Shift+F10":   "PF22", "Shift+F11":"PF23", "Shift+F12":"PF24",
    "PageUp":      "RollDown",  // 5250 Roll keys: PgUp scrolls toward top
    "PageDown":    "RollUp",
    "Escape":      "Reset",     // Reset unlocks the keyboard (local)
    "Pause":       "Attn",      // Attention
    "Shift+Escape":"Clear",
    "Ctrl+p":      "Print",
    "Ctrl+s":      "SysReq",    // System Request
    "Ctrl+h":      "Help",      // Help (F1 is PF1, so Help gets a dedicated key)
    "Ctrl+d":      "Dup",       // Duplicate
    "Ctrl+e":      "EraseEOF",  // Erase to end of field (local)
    "End":         "FieldExit",
    "Shift+End":   "FieldPlus",
    "Ctrl+End":    "FieldMinus",
    "RightAlt":    "Enter",     // macOS right option key alone = Enter
    "Home":        "Home",
    "Insert":      "Insert",
};

let keymap = {};

// All 5250 functions that can be mapped
const ALL_FUNCTIONS = [
    "Enter", "NewLine",
    "PF1","PF2","PF3","PF4","PF5","PF6","PF7","PF8","PF9","PF10","PF11","PF12",
    "PF13","PF14","PF15","PF16","PF17","PF18","PF19","PF20","PF21","PF22","PF23","PF24",
    "Help", "RollUp", "RollDown", "Print", "SysReq", "Attn",
    "Clear", "FieldExit", "FieldPlus", "FieldMinus", "Dup",
    "Reset", "EraseEOF", "Home", "Insert"
];

// Local actions (cursor/navigation/keyboard control, not sent to host as an AID).
// FieldExit, Field+, Field-, and Dup are performed instantly in the browser
// (fieldExit()/fieldPlus()/fieldMinus()/dupField()) so they never lock the
// keyboard or round-trip to the server — matching tn5250's local kf_* handlers.
const LOCAL_ACTIONS = new Set(["NewLine", "Reset", "EraseEOF", "Home", "Insert",
                               "FieldExit", "FieldPlus", "FieldMinus", "Dup"]);

// AID functions (keys that send an AID + field data to the host).
// The Go server maps each name to its 5250 AID byte:
//   Enter, PF1..PF24, Help, RollUp, RollDown, Print, SysReq, Attn, Clear.
const AID_KEYS = new Set(ALL_FUNCTIONS.filter(f => !LOCAL_ACTIONS.has(f)));

function loadKeymap() {
    try {
        const saved = localStorage.getItem("web5250-keymap");
        if (saved) {
            keymap = JSON.parse(saved);
        } else {
            keymap = Object.assign({}, DEFAULT_KEYMAP);
        }
    } catch(e) {
        keymap = Object.assign({}, DEFAULT_KEYMAP);
    }
}

function saveKeymap() {
    localStorage.setItem("web5250-keymap", JSON.stringify(keymap));
}

// ── Terminal rendering ──────────────────────────────────────────────

const termEl = document.getElementById("terminal");

function buildGrid() {
    renderedCells = null; // invalidate — DOM is rebuilt from scratch
    termEl.innerHTML = "";
    for (let r = 0; r < rows; r++) {
        const rowDiv = document.createElement("div");
        rowDiv.className = "row";
        for (let c = 0; c < cols; c++) {
            const span = document.createElement("span");
            span.textContent = " ";
            span.dataset.addr = r * cols + c;
            rowDiv.appendChild(span);
        }
        termEl.appendChild(rowDiv);
    }
}

// renderedCells holds a snapshot of what is currently displayed in the DOM.
// At render time we compare cells[] against renderedCells[] and only touch
// spans that differ — the same strategy x3270 uses (saved_ea vs ea_buf).
// This is immune to coalescing issues: no matter how many deltas arrive
// between repaints, the diff is always correct.
let renderedCells = null;

function cellClassName(cell, addr) {
    let cls = "c-" + (cell.fg || "green");
    if (cell.bg) cls += " bg-" + cell.bg;
    if (cell.int) cls += " c-intense";
    // Highlights are additive: the server sends a space-joined set like
    // "reverse underscore", one CSS class per token (h-reverse, h-underscore, …).
    for (const h of (cell.hi || "").split(" ")) { if (h) cls += " h-" + h; }
    if (!cell.prot) cls += " field-input";
    if (addr === cursorAddr) cls += " cursor";
    return cls;
}

// Returns the [start,end] span-index range covered by an active native text
// selection inside the terminal, or null if there is none. Used by renderScreen
// to avoid repainting selected cells (which would smear the browser's highlight
// into ghost rectangles that never clear).
function selectedAddrRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    if (!termEl.contains(sel.anchorNode) && !termEl.contains(sel.focusNode)) return null;
    const spans = getSpans();
    let start = -1, end = -1;
    for (let i = 0; i < spans.length; i++) {
        if (sel.containsNode(spans[i], true)) { if (start === -1) start = i; end = i; }
    }
    return start < 0 ? null : { start, end };
}

function renderScreen() {
    const spans = getSpans();
    const size = rows * cols;
    const canDiff = renderedCells !== null && renderedCells.length === size && cells.length === size;
    const selRange = selectedAddrRange();

    for (let i = 0; i < size && i < cells.length; i++) {
        // Leave cells inside an active selection untouched so the browser's
        // highlight is never smeared into a ghost. The rest of the screen still
        // updates live; a left-mouse reset (or keystroke) forces a clean repaint.
        if (selRange && i >= selRange.start && i <= selRange.end) continue;
        const cell = cells[i];

        // x3270-style diff: skip cells identical to what was last rendered
        if (canDiff) {
            const prev = renderedCells[i];
            if (prev.c === cell.c && prev.fg === cell.fg && prev.bg === cell.bg &&
                prev.hi === cell.hi && prev.prot === cell.prot &&
                prev.hid === cell.hid && prev.int === cell.int &&
                // cursor may have moved — always repaint old and new cursor positions
                i !== cursorAddr && prev._cursor !== true) {
                continue;
            }
        }

        const span = spans[i];
        if (!span) continue;
        span.textContent = cellGlyph(cell);
        span.className = cellClassName(cell, i);
    }

    // Ensure exactly one cursor: remove stale cursor from tracked position
    // if it differs from cursorAddr (handles races between moveCursorDOM
    // and renderScreen that can leave ghost cursors).
    if (cursorDOMAddr >= 0 && cursorDOMAddr !== cursorAddr && cursorDOMAddr < spans.length) {
        spans[cursorDOMAddr].className = spans[cursorDOMAddr].className.replace(" cursor", "");
    }
    cursorDOMAddr = cursorAddr;

    // Save snapshot of rendered state (shallow copy of each cell + cursor flag)
    const prevSnap = renderedCells;
    renderedCells = new Array(size);
    for (let i = 0; i < size && i < cells.length; i++) {
        // Selected cells were not repainted above. Keep the old snapshot when we
        // have it (the DOM still shows exactly that), so the next render detects
        // them dirty. If no prior snapshot exists (a full-screen update nulled it
        // while the selection was held), store a sentinel that can never equal a
        // real cell char — this guarantees a repaint once the selection clears,
        // even if that happens via a click outside the terminal.
        if (selRange && i >= selRange.start && i <= selRange.end) {
            renderedCells[i] = (prevSnap && prevSnap[i]) ? prevSnap[i] : { c: "\u0000" };
            continue;
        }
        const c = cells[i];
        renderedCells[i] = { c: c.c, fg: c.fg, bg: c.bg, hi: c.hi,
                             prot: c.prot, hid: c.hid, int: c.int,
                             _cursor: i === cursorAddr };
    }

    renderGuiOverlay();
    updateStatusBar();
}

// ── Enhanced (GUI) overlay rendering ────────────────────────────────────
// Windows, selection fields and scroll bars are drawn on a transparent layer
// sitting exactly over the cell grid, so the ordinary cell render is never
// disturbed (the overlay owns no <span>s inside #terminal, keeping getSpans()
// unaffected). Every element is positioned in pixels measured from the real
// cell spans, so it stays aligned across any font/size/theme.

let overlayEl = null;
let overlayHasContent = false;

function getOverlayEl() {
    if (overlayEl) return overlayEl;
    const wrap = document.getElementById("terminal-wrap");
    overlayEl = document.createElement("div");
    overlayEl.id = "terminal-overlay";
    // Insert as the first child so it layers over #terminal (which follows it in
    // the stacking context via z-index in CSS).
    wrap.insertBefore(overlayEl, wrap.firstChild);
    return overlayEl;
}

function renderGuiOverlay() {
    const hasOverlays = guiWindows.length > 0 || guiSelections.length > 0 ||
                        guiScrollbars.length > 0;
    if (!hasOverlays) {
        // Fast path for ordinary screens: only touch the DOM if we drew before.
        if (overlayHasContent && overlayEl) {
            overlayEl.textContent = "";
            overlayHasContent = false;
        }
        return;
    }

    const overlay = getOverlayEl();
    const spans = getSpans();
    if (!spans || spans.length < 2) { overlay.textContent = ""; overlayHasContent = false; return; }

    // Measure the real cell geometry so the overlay lines up under any font.
    const r0 = spans[0].getBoundingClientRect();
    const ovRect = overlay.getBoundingClientRect();
    let cellW = r0.width, cellH = r0.height;
    if (spans[1]) { const d = spans[1].getBoundingClientRect().left - r0.left; if (d > 0) cellW = d; }
    if (spans[cols]) { const d = spans[cols].getBoundingClientRect().top - r0.top; if (d > 0) cellH = d; }
    const offX = r0.left - ovRect.left;
    const offY = r0.top - ovRect.top;

    // Match the terminal's font so border/box glyphs render at cell size.
    overlay.style.fontFamily = termEl.style.fontFamily || "";
    overlay.style.fontSize = termEl.style.fontSize || "";

    const frag = document.createDocumentFragment();
    const put = function(row, col, ch, cls) {
        if (row < 0 || col < 0 || row >= rows || col >= cols) return;
        const d = document.createElement("div");
        d.className = "ov-cell" + (cls ? " " + cls : "");
        d.style.left = (offX + col * cellW) + "px";
        d.style.top = (offY + row * cellH) + "px";
        d.style.width = cellW + "px";
        d.style.height = cellH + "px";
        d.style.lineHeight = cellH + "px";
        d.textContent = ch;
        frag.appendChild(d);
    };

    for (const w of guiWindows) drawWindowBox(w, put);
    for (const s of guiSelections) drawSelectionField(s, put);
    for (const sb of guiScrollbars) drawScrollbarOverlay(sb, put);

    overlay.textContent = "";
    overlay.appendChild(frag);
    overlayHasContent = true;
}

// drawWindowBox paints a window's border. The corner is at (w.row,w.col) and the
// box is (w.h+2) rows by (w.w+2) cols; border runes are UL,top,UR,left,right,
// LL,bottom,LR (see the server's SnapWindow).
function drawWindowBox(w, put) {
    if (!w || w.w <= 0 || w.h < 0) return;
    const b = Array.from(w.border || "");
    while (b.length < 8) b.push(" ");
    const UL = b[0], TOP = b[1], UR = b[2], LEFT = b[3],
          RIGHT = b[4], LL = b[5], BOT = b[6], LR = b[7];
    const top = w.row, left = w.col;
    const bottom = w.row + w.h + 1, right = w.col + w.w + 1;
    put(top, left, UL, "ov-border");
    put(top, right, UR, "ov-border");
    put(bottom, left, LL, "ov-border");
    put(bottom, right, LR, "ov-border");
    for (let c = left + 1; c < right; c++) {
        put(top, c, TOP, "ov-border");
        put(bottom, c, BOT, "ov-border");
    }
    for (let r = top + 1; r < bottom; r++) {
        put(r, left, LEFT, "ov-border");
        put(r, right, RIGHT, "ov-border");
    }
}

// drawSelectionField paints each choice's text, highlighting the selected one and
// dimming unavailable choices.
function drawSelectionField(s, put) {
    if (!s || !s.items) return;
    for (const it of s.items) {
        const chars = Array.from(it.text || "");
        let cls = "ov-choice";
        if (it.sel) cls += " ov-choice-sel";
        else if (!it.avail) cls += " ov-choice-unavail";
        for (let i = 0; i < chars.length; i++) {
            put(it.row, it.col + i, chars[i], cls);
        }
    }
}

// drawScrollbarOverlay paints a simple track with a slider block whose position
// reflects slider/total.
function drawScrollbarOverlay(sb, put) {
    const size = sb.size || 0;
    if (size <= 0) return;
    const total = sb.total || 0;
    let sliderIdx = 0;
    if (total > 1) sliderIdx = Math.round((sb.slider / total) * (size - 1));
    if (sliderIdx < 0) sliderIdx = 0;
    if (sliderIdx >= size) sliderIdx = size - 1;
    for (let i = 0; i < size; i++) {
        const slider = (i === sliderIdx);
        const ch = slider ? "█" : "░"; // █ full block / ░ light shade
        const cls = slider ? "ov-scroll-slider" : "ov-scroll-track";
        if (sb.horiz) put(sb.row, sb.col + i, ch, cls);
        else put(sb.row + i, sb.col, ch, cls);
    }
}

// scheduleRender coalesces rapid screen updates (e.g. screensaver frames)
// into a single render per animation frame, keeping the JS thread free
// for keydown events between frames.
function scheduleRender() {
    if (!pendingRender) {
        pendingRender = true;
        requestAnimationFrame(function() {
            pendingRender = false;
            renderScreen();
        });
    }
}

function updateStatusBar() {
    const r = Math.floor(cursorAddr / cols);
    const c = cursorAddr % cols;
    document.getElementById("status-cursor").textContent =
        `Row: ${r}  Col: ${c}`;
    document.getElementById("status-mode").textContent =
        insertMode ? "INS" : "OVR";
    updateOIA();
}

// oiaShift returns the keyboard-shift indicator (5250 KS) for the field at the
// cursor: "A" alphabetic shift, "N" numeric, "K" katakana; blank when the cursor
// is not in an input field. Derived from SnapField.ftype (already on fields[]).
function oiaShift() {
    if (!connected) return "";
    // The KS "A" indicator lights ONLY when uppercase input is active: a Shift
    // key is held, Caps/Shift-lock is on, or the field at the cursor is monocase
    // (forced to uppercase). It does not light just because a field is alphabetic.
    if (shiftHeld || capsLock) return "A";
    const f = getFieldAtAddr(cursorAddr);
    if (f && !f.prot && f.mono) return "A";
    return "";
}

// trackShift updates the Shift-held / Caps-lock state from a key event and
// refreshes the OIA only when it changes (drives the KS "A" indicator).
function trackShift(e) {
    const sh = !!e.shiftKey;
    const cl = e.getModifierState ? e.getModifierState("CapsLock") : false;
    if (sh !== shiftHeld || cl !== capsLock) {
        shiftHeld = sh;
        capsLock = cl;
        updateOIA();
    }
}

// clockGlyph returns an inline SVG of a clock face — a circle with 12 hour tick
// marks, no hands and no numbers — used for the "X CLOCK" OIA indicator, and
// (with crossed=true) a diagonal slash through the circle to mark "no connection".
// Sized at 0.85em (smaller than the "X" beside it), inheriting the OIA color.
function clockGlyph(crossed) {
    let ticks = "";
    for (let k = 0; k < 12; k++) {
        const a = k * Math.PI / 6;                         // 30° per hour mark
        const inner = (k % 3 === 0) ? 5.5 : 8;             // longer marks at 12, 3, 6, 9
        const ox = 12 + 10 * Math.sin(a), oy = 12 - 10 * Math.cos(a);       // outer (rim)
        const ix = 12 + inner * Math.sin(a), iy = 12 - inner * Math.cos(a); // inner
        ticks += `<line x1="${ox.toFixed(2)}" y1="${oy.toFixed(2)}" x2="${ix.toFixed(2)}" y2="${iy.toFixed(2)}"/>`;
    }
    // Slash runs from just outside the circle's top-left edge to just outside
    // its bottom-right edge (circle diagonal edge is ~4.6..19.4), so it clearly
    // protrudes past the frame on both ends.
    const slash = crossed ? `<line x1="2.5" y1="2.5" x2="21.5" y2="21.5"/>` : "";
    return `<svg viewBox="0 0 24 24" width="0.85em" height="0.85em" style="vertical-align:-0.12em" `
         + `fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="10.5"/>${ticks}${slash}</svg>`;
}

// updateOIA is the SINGLE source of truth for the Operator Information Area (the
// row below the display), mirroring tn5250 (cursesterm.c
// curses_terminal_update_indicators): the "5250" label, one mutually-exclusive
// input-inhibit indicator (X II > X CLOCK > X SYSTEM, plus X Disconnected), the
// keyboard shift, the MW / IM / FER flags, and the column/row cursor position.
function updateOIA() {
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };

    set("oia-5250", connected ? "5250" : "");

    // Input-inhibit indicator (single slot). Priority follows tn5250's col-9
    // (II > CLOCK > SYSTEM), extended with our local disconnect/operator-error.
    const status = document.getElementById("oia-status");
    if (status) {
        let color = "#fff";
        if (!connected) {
            // No connection: X + a crossed clock face (circle with a slash).
            status.innerHTML = "X " + clockGlyph(true);
        } else if (kbdInhibit) {
            status.textContent = operatorErrMsg || "X II"; // local operator error (specific message)
            color = "#f44747";
        } else if (hostInhibit) {
            status.textContent = "X II";                   // host input inhibit (e.g. Write Error Code)
        } else if (hostXClock) {
            // "X CLOCK": an X followed by a small clock-face symbol (circle with
            // 12 hour ticks, no hands/numbers), sized not to exceed the X.
            status.innerHTML = "X " + clockGlyph();
        } else if (kbdLocked || hostXSystem) {
            status.textContent = "X SYSTEM";
        } else {
            status.textContent = "";
        }
        status.style.color = color;
    }

    set("oia-shift", oiaShift());
    set("oia-mw", hostMW ? "MW" : "");
    set("oia-insert", insertMode ? "IM" : "");
    set("oia-fer", ferActive ? "FER" : "");

    const r = Math.floor(cursorAddr / cols), c = cursorAddr % cols;
    set("oia-pos", String(c + 1).padStart(3, "0") + "/" + String(r + 1).padStart(3, "0"));
}

// Thin compatibility shims — the flags they used to reflect are now read by
// updateOIA(); callers just need a re-render.
function oiaWait()         { updateOIA(); }
function oiaDisconnected() { updateOIA(); }

// ── Field navigation ────────────────────────────────────────────────

function getFieldAtAddr(addr) {
    const size = rows * cols;
    if (fields.length === 0) return null;

    // Find the field whose data range contains addr.
    // tn5250 convention: f.addr is the field's FIRST DATA cell; the 5250
    // attribute byte sits at f.addr-1. Data runs from f.addr for f.len cells.
    for (const f of fields) {
        // Distance from the first data cell to addr, wrapping around.
        const dist = (addr - f.addr + size) % size;
        // dist 0..f.len-1 means addr is within the field's data area.
        if (dist < f.len) return f;
    }
    return null;
}

function isProtectedAddr(addr) {
    const f = getFieldAtAddr(addr);
    return !f || f.prot;
}

function nextUnprotectedField() {
    const size = rows * cols;
    const oldCursor = cursorAddr;
    // Honor a host-specified cursor progression (FCW 0x88) on Tab, if the field
    // the cursor is currently in defines one.
    const cur = getFieldAtAddr(cursorAddr);
    if (cur && cur.nextprog) {
        const prog = nextFieldAfter(cur, cursorAddr);
        if (prog >= 0) {
            cursorAddr = prog;
            moveCursorDOM(oldCursor, cursorAddr);
            return;
        }
    }
    for (let i = 1; i < size; i++) {
        const addr = (cursorAddr + i) % size;
        for (const f of fields) {
            if (f.prot) continue;
            const start = f.addr % size;
            if (addr === start) {
                cursorAddr = start;
                moveCursorDOM(oldCursor, cursorAddr);
                return;
            }
        }
    }
}

function prevUnprotectedField() {
    const size = rows * cols;
    const oldCursor = cursorAddr;
    // Scan backward from cursor, like x3270's BackTab_action.
    const unprotFields = fields.filter(f => !f.prot);
    if (unprotFields.length === 0) return;

    const starts = unprotFields.map(f => f.addr % size).sort((a, b) => a - b);

    let best = -1;
    for (let i = starts.length - 1; i >= 0; i--) {
        if (starts[i] < cursorAddr) {
            best = starts[i];
            break;
        }
    }
    if (best < 0) {
        best = starts[starts.length - 1];
    }

    cursorAddr = best;
    moveCursorDOM(oldCursor, cursorAddr);
}

// newLine moves cursor to the first unprotected field on the next row.
// If no unprotected field exists on the next row, continues scanning
// subsequent rows, wrapping around the screen.
function newLine() {
    if (kbdLocked) return;
    const size = rows * cols;
    const oldCursor = cursorAddr;
    // Start of next row
    const curRow = Math.floor(cursorAddr / cols);
    let startAddr = ((curRow + 1) % rows) * cols;

    // Scan from start of next row for the first unprotected position
    for (let i = 0; i < size; i++) {
        const addr = (startAddr + i) % size;
        if (!isProtectedAddr(addr)) {
            cursorAddr = addr;
            moveCursorDOM(oldCursor, cursorAddr);
            return;
        }
    }
    // No unprotected field found — move to start of next row anyway
    cursorAddr = startAddr;
    moveCursorDOM(oldCursor, cursorAddr);
}

function firstUnprotectedField() {
    const oldCursor = cursorAddr;
    for (const f of fields) {
        if (!f.prot) {
            cursorAddr = f.addr % (rows * cols);
            moveCursorDOM(oldCursor, cursorAddr);
            return;
        }
    }
}

// ── Fast single-cell DOM updates ────────────────────────────────────
// Used by input functions to avoid full renderScreen() on every keystroke.

// Cached reference to all spans — rebuilt when grid changes.
let spanCache = null;

function getSpans() {
    if (!spanCache || spanCache.length !== rows * cols) {
        spanCache = termEl.querySelectorAll("span");
    }
    return spanCache;
}

// Invalidate span cache when grid is rebuilt
const origBuildGrid = buildGrid;
buildGrid = function() {
    origBuildGrid();
    spanCache = null;
};

// Update a single cell's span to match the cells[] data
// cellGlyph returns the visible character for a cell. Hidden (nondisplay) cells
// and the DUP sentinel (U+001C, transmitted as EBCDIC 0x1C) render as a blank,
// matching tn5250's curses terminal, which draws control bytes as blanks.
function cellGlyph(cell) {
    if (cell.hid) return " ";
    const c = cell.c;
    if (!c || c === "") return " ";
    return c;
}

function updateCellDOM(addr) {
    const spans = getSpans();
    const span = spans[addr];
    if (!span) return;
    const cell = cells[addr];
    if (!cell) return;

    span.textContent = cellGlyph(cell);

    let cls = "c-" + (cell.fg || "green");
    if (cell.bg) cls += " bg-" + cell.bg;
    if (cell.int) cls += " c-intense";
    // Highlights are additive: the server sends a space-joined set like
    // "reverse underscore", one CSS class per token (h-reverse, h-underscore, …).
    for (const h of (cell.hi || "").split(" ")) { if (h) cls += " h-" + h; }
    if (!cell.prot) cls += " field-input";
    if (addr === cursorAddr) cls += " cursor";
    span.className = cls;

    // Keep the diff renderer's snapshot in sync with what we just painted.
    // Otherwise a host delta that resets a typed cell back to space would
    // be skipped by renderScreen() because cells[addr] === renderedCells[addr]
    // (the pre-typing host view). The diff must compare against DOM truth.
    if (renderedCells && renderedCells[addr]) {
        renderedCells[addr].c    = cell.c;
        renderedCells[addr].fg   = cell.fg;
        renderedCells[addr].bg   = cell.bg;
        renderedCells[addr].hi   = cell.hi;
        renderedCells[addr].int  = cell.int;
        renderedCells[addr].hid  = cell.hid;
        renderedCells[addr].prot = cell.prot;
    }
}

// Track which span currently has the cursor class in the DOM,
// so we can always clean it up reliably — prevents ghost cursors.
let cursorDOMAddr = -1;

// Move cursor: remove cursor class from old position, add to new
function moveCursorDOM(oldAddr, newAddr) {
    const spans = getSpans();
    // Remove from tracked position (more reliable than oldAddr)
    if (cursorDOMAddr >= 0 && cursorDOMAddr < spans.length) {
        spans[cursorDOMAddr].className = spans[cursorDOMAddr].className.replace(" cursor", "");
    }
    // Also remove from oldAddr in case it differs
    if (oldAddr >= 0 && oldAddr !== cursorDOMAddr && oldAddr < spans.length) {
        spans[oldAddr].className = spans[oldAddr].className.replace(" cursor", "");
    }
    if (newAddr >= 0 && newAddr < spans.length) {
        if (!spans[newAddr].className.includes(" cursor")) {
            spans[newAddr].className += " cursor";
        }
        cursorDOMAddr = newAddr;
    }
    updateStatusBar();
}

// ── Character input ─────────────────────────────────────────────────

// fieldEnd returns the address one past the last data position of a field.
function fieldEndAddr(f) {
    return (f.addr + f.len) % (rows * cols);
}

// validCharForField mirrors tn5250_field_valid_char (field.c:394-446): decide
// whether ch is an allowed data character for the field's format-word type.
//   0 alpha-shift / 2 num-shift / 4 kata → any character
//   1 alpha-only  → letters + space , . -
//   3 num-only    → digits  + space , . -   (sign keys handled separately)
//   5 digit-only  → digits only
//   6 mag-reader  → no keyboard data allowed
//   7 signed-num  → digits only             (sign keys handled separately)
function validCharForField(f, ch) {
    switch (f.ftype) {
    case 1: // alpha-only
        return /[a-zA-Z]/.test(ch) || ch === " " || ch === "," || ch === "." || ch === "-";
    case 3: // num-only
        return /[0-9]/.test(ch) || ch === " " || ch === "," || ch === "." || ch === "-";
    case 5: // digit-only
    case 7: // signed-num (sign position handled by Field±)
        return /[0-9]/.test(ch);
    case 6: // mag-reader: keyboard data not allowed
        return false;
    default: // 0 alpha-shift, 2 num-shift, 4 kata, or unspecified
        return true;
    }
}

function typeChar(ch) {
    if (kbdLocked) return;

    // FER inhibit: while a field-exit-required field is full, reject data keys
    // until Field Exit / Field± / an arrow / Reset clears it (do_key FER logic).
    if (ferActive) {
        setFER(); // re-assert the persistent indicator
        return;
    }
    // Operator-error inhibit ("X II"): reject data keys until Reset clears it.
    if (kbdInhibit) return;

    if (isProtectedAddr(cursorAddr)) {
        oiaOperatorError("X Protected");
        return;
    }

    const f = getFieldAtAddr(cursorAddr);
    if (!f) return;

    // Monocase fields upper-case alphabetic input before storing
    // (display.c interactive_addch: is_monocase + toupper).
    if (f.mono) ch = ch.toUpperCase();

    // Sign-key hack: in num-only(3)/signed(7) fields, typing '-'/'+' invokes
    // Field-/Field+ instead of inserting the literal (display.c
    // interactive_addch:928-940). Field± stay server round-trips (sendAID) so the
    // server performs the correct signed sign-digit encoding — not reimplemented.
    if (f.ftype === 3 || f.ftype === 7) {
        if (ch === "-") { fieldMinus(); return; }
        if (ch === "+") { fieldPlus(); return; }
    }

    // Precise per-field-type input validation (field.c tn5250_field_valid_char).
    if (!validCharForField(f, ch)) {
        oiaOperatorError("X " + (f.ftype === 1 ? "Alpha only" : "Numeric only"));
        return;
    }

    const size = rows * cols;
    const fEnd = fieldEndAddr(f);
    const oldCursor = cursorAddr;

    if (insertMode) {
        // Insert mode: shift characters right within the field.
        // If the last position is non-blank, reject the insert.
        const lastAddr = (fEnd - 1 + size) % size;
        if (cells[lastAddr] && cells[lastAddr].c && cells[lastAddr].c.trim() !== "") {
            oiaOperatorError("X Overflow");
            return; // field full
        }
        // Shift right from end of field to cursor, updating DOM for each shifted cell
        for (let pos = lastAddr; pos !== cursorAddr; ) {
            const prev = (pos - 1 + size) % size;
            if (prev === (f.addr - 1 + size) % size) break; // don't shift into the attribute cell
            cells[pos].c = cells[prev].c;
            updateCellDOM(pos);
            pos = prev;
        }
    }

    // Update the cell
    const idx = cursorAddr;
    if (idx < cells.length) {
        cells[idx].c = ch;
    }

    // Mark field as modified
    fieldMDT[f.addr] = true;

    // Advance cursor within the field.
    cursorAddr = (cursorAddr + 1) % size;

    // Field full (cursor reached the position past the last data cell).
    if (cursorAddr === fEnd) {
        if (f.fer) {
            // Field-exit-required: do NOT auto-skip. Hold the cursor on the last
            // data cell and set the FER inhibit so further data keys are rejected
            // until Field Exit / Field± / an arrow / Reset (display.c
            // interactive_addch sets IND_FER; do_key enforces the inhibit).
            cursorAddr = (fEnd - 1 + size) % size;
            setFER();
        } else {
            // Auto-skip to the first data cell of the next non-bypass field,
            // matching tn5250's interactive_addch (set_cursor_next_field).
            const nf = nextFieldAfter(f, cursorAddr);
            if (nf >= 0) cursorAddr = nf;
        }
    }

    // Fast DOM update: the typed cell + a single cursor move to the final spot.
    updateCellDOM(idx);
    moveCursorDOM(oldCursor, cursorAddr);
}

// nextFieldStartFrom returns the first data cell of the next non-bypass field
// at or after fromAddr (wrapping around the screen), or -1 if there are none.
function nextFieldStartFrom(fromAddr) {
    const size = rows * cols;
    for (let i = 0; i < size; i++) {
        const addr = (fromAddr + i) % size;
        for (const f of fields) {
            if (!f.prot && (f.addr % size) === addr) return addr;
        }
    }
    return -1;
}

// nextFieldAfter returns the addr the cursor advances to after leaving field f:
// the host-specified cursor-progression field (FCW 0x88; f.nextprog gives the
// id of the next field) if set and present, otherwise the next physical
// non-bypass field from fromAddr. Mirrors tn5250 display.c, which honors the
// progression id on Tab and on field-fill.
function nextFieldAfter(f, fromAddr) {
    if (f && f.nextprog) {
        const target = fields.find(ff => ff.id === f.nextprog && !ff.prot);
        if (target) return target.addr % (rows * cols);
    }
    return nextFieldStartFrom(fromAddr);
}

// prevFieldLastCell returns the last data cell of the nearest non-bypass field
// ending before the cursor (wrapping), or -1 if there are none.
function prevFieldLastCell() {
    const size = rows * cols;
    let best = -1, bestDist = Infinity;
    for (const f of fields) {
        if (f.prot) continue;
        const last = (f.addr + f.len - 1) % size;
        const dist = (cursorAddr - last + size) % size; // backward distance
        if (dist > 0 && dist < bestDist) { bestDist = dist; best = last; }
    }
    return best;
}

// backspace matches tn5250's default kf_backspace (display.c:1970-1997): it is
// NON-destructive — it only repositions the cursor one position left. At the
// first data cell of a field it hops to the LAST data cell of the previous
// non-bypass field. (Destructive erase is the separate Delete key.)
function backspace() {
    if (kbdLocked) return;
    const size = rows * cols;
    const oldCursor = cursorAddr;
    const f = getFieldAtAddr(cursorAddr);

    // At the left edge of a field, jump to the end of the previous field.
    if (f && cursorAddr === (f.addr % size)) {
        const pf = prevFieldLastCell();
        if (pf >= 0) {
            cursorAddr = pf;
            moveCursorDOM(oldCursor, cursorAddr);
        }
        return;
    }

    const prev = (cursorAddr - 1 + size) % size;
    if (isProtectedAddr(prev)) return; // don't cross into a protected cell
    cursorAddr = prev;
    moveCursorDOM(oldCursor, cursorAddr);
}

function deleteChar() {
    if (kbdLocked) return;
    if (isProtectedAddr(cursorAddr)) return;
    deleteCharShiftLeft();
}

// oiaOperatorError records a local operator error: it inhibits input ("X II"
// family) and PERSISTS until Reset/Error-Reset, matching tn5250 (display.c). The
// specific message (e.g. "X Protected") is shown in the OIA X-status slot.
function oiaOperatorError(msg) {
    operatorErrMsg = msg;
    kbdInhibit = true;
    updateOIA();
}

// ── Field-Exit-Required (FER) inhibit ───────────────────────────────
// When a FER field fills, tn5250 (display.c interactive_addch) sets the FER
// indicator and holds the cursor at the field end. do_key then rejects all
// data keys until Field Exit / Field± / an arrow / Reset clears the state.
// We model that with the ferActive flag, shown in its own OIA "FER" slot.

function setFER() {
    ferActive = true;
    updateOIA();
}

// clearFER releases the FER inhibit (Field Exit/Field±/arrow/Tab/Reset/AID).
function clearFER() {
    if (!ferActive) return;
    ferActive = false;
    updateOIA();
}

// deleteCharShiftLeft shifts all characters from cursor+1 to end of field
// one position left, filling the last position with a blank.
// Updates only the affected spans in the DOM.
function deleteCharShiftLeft() {
    const f = getFieldAtAddr(cursorAddr);
    if (!f) return;

    const size = rows * cols;
    const fEnd = fieldEndAddr(f);

    let pos = cursorAddr;
    while (true) {
        const next = (pos + 1) % size;
        if (next === fEnd) {
            cells[pos].c = " ";
            updateCellDOM(pos);
            break;
        }
        cells[pos].c = cells[next].c;
        updateCellDOM(pos);
        pos = next;
    }

    fieldMDT[f.addr] = true;
}

function eraseEOF() {
    if (kbdLocked) return;
    if (isProtectedAddr(cursorAddr)) return;

    const f = getFieldAtAddr(cursorAddr);
    if (!f) return;

    const size = rows * cols;
    const fEnd = fieldEndAddr(f);

    let pos = cursorAddr;
    while (pos !== fEnd) {
        cells[pos].c = " ";
        updateCellDOM(pos);
        pos = (pos + 1) % size;
    }

    fieldMDT[f.addr] = true;
}

// ── Local Field Exit / Dup ──────────────────────────────────────────
// Field Exit and Dup are performed entirely in the browser so they respond
// instantly — no AID, no keyboard lock, no server round-trip. They mirror
// tn5250's display.c kf_field_exit / field_pad_and_adjust / kf_dup.

// repaintField refreshes every DOM cell of a field. Used after operations that
// may move data across the whole field (field adjust / dup fill).
function repaintField(f) {
    const size = rows * cols;
    const start = f.addr % size;
    for (let i = 0; i < f.len; i++) {
        updateCellDOM((start + i) % size);
    }
}

// shiftFieldRight mirrors display.c tn5250_display_shift_right: move all data
// characters to the right-hand end of the field and left-fill with `fill`. A
// cell counts as empty when it is null ("") or a blank (" ") — matching C's
// `ptr[n]==0 || ptr[n]==0x40`. Signed-num (ftype 7) fields keep their trailing
// sign position fixed (end--), exactly like the C code.
function shiftFieldRight(f, fill) {
    const size = rows * cols;
    const start = f.addr % size;
    let end = f.len - 1;          // index (within the field) of the last data cell
    if (f.ftype === 7) end--;     // signed-num: do not adjust the sign position

    const at = (i) => cells[(start + i) % size];
    const isEmpty = (i) => {
        const cc = at(i).c;
        return cc === "" || cc === " " || cc === undefined;
    };

    // Left-fill leading empty cells until the first real data character.
    let n = 0;
    for (; n <= end && isEmpty(n); n++) at(n).c = fill;
    if (n > end) return;          // field entirely empty — nothing to justify

    // Shift the contents right one place at a time until the last cell holds
    // real data (right-justified), left-filling position 0 each pass.
    while (isEmpty(end)) {
        for (let k = end; k > 0; k--) at(k).c = at(k - 1).c;
        at(0).c = fill;
    }
}

// fieldExit performs a LOCAL Field Exit (display.c kf_field_exit +
// field_pad_and_adjust): clear from the cursor to the end of the field, right-
// adjust if the field format word requests it, set MDT, then auto-enter or skip
// to the next field.
// fieldExit performs Field Exit / Field+ / Field- as instant LOCAL operations
// (tn5250 display.c kf_field_exit/plus/minus). sign is undefined for a plain
// Field Exit, "+" for Field+, "-" for Field-.
function fieldExit(sign) {
    if (kbdLocked || kbdInhibit) return;

    const f = getFieldAtAddr(cursorAddr);
    // Require an unprotected (non-bypass) field at the cursor, else operator error.
    if (!f || f.prot) {
        oiaOperatorError("X Protected");
        return;
    }
    // Field- is only valid in a numeric-only (3) or signed-numeric (7) field.
    if (sign === "-" && f.ftype !== 3 && f.ftype !== 7) {
        oiaOperatorError("X Field-");
        return;
    }

    // Field Exit / Field± are among the keys that release a FER inhibit.
    clearFER();

    const size = rows * cols;
    const fEnd = fieldEndAddr(f);

    // Null out the remainder of the field from the cursor position (field
    // _pad_and_adjust nulls trailing cells; our null cell is the empty string).
    for (let pos = cursorAddr; pos !== fEnd; pos = (pos + 1) % size) {
        cells[pos].c = "";
    }

    // Right-adjust the entered data if requested: adj 5 = right-justify with
    // leading zeros, adj 6/7 = right-justify with leading blanks.
    if (f.adj === 5)                     shiftFieldRight(f, "0");
    else if (f.adj === 6 || f.adj === 7) shiftFieldRight(f, " ");
    else if ((sign === "-" || sign === "+") && f.ftype === 7) shiftFieldRight(f, " ");

    // Field+ / Field-: place the sign in the field's last (sign) position. The
    // server derives the signed sign-digit from a trailing '-' (session_read.go),
    // so we only set/clear the '-' here and let the server do the encoding.
    if (sign === "-" || sign === "+") {
        const last = (f.addr + f.len - 1) % size;
        if (sign === "-")               cells[last].c = "-";
        else if (cells[last].c === "-") cells[last].c = "";
    }

    fieldMDT[f.addr] = true;
    repaintField(f);

    // Auto-enter fields transmit Enter; otherwise skip to the next field.
    if (f.auto) {
        sendAID("Enter");
        return;
    }
    const oldCursor = cursorAddr;
    const nf = nextFieldAfter(f, fEnd);
    if (nf >= 0) cursorAddr = nf;
    moveCursorDOM(oldCursor, cursorAddr);
}

// Field+ / Field- are local operations (tn5250 kf_field_plus/kf_field_minus).
function fieldPlus()  { fieldExit("+"); }
function fieldMinus() { fieldExit("-"); }

// dupField performs a LOCAL Dup (display.c kf_dup). Only valid when the field's
// dup-enable flag is set. Fills from the cursor to the end of the field with the
// DUP fill, sets MDT, then (respecting FER / auto-enter) skips to the next field.
function dupField() {
    if (kbdLocked) return;

    const f = getFieldAtAddr(cursorAddr);
    if (!f || f.prot) {
        oiaOperatorError("X Protected");
        return;
    }
    // do_key: Dup on a field without dup-enable is an operator error.
    if (!f.dup) {
        oiaOperatorError("X Dup");
        return;
    }

    clearFER();

    const size = rows * cols;
    const fEnd = fieldEndAddr(f);

    // Fill from the cursor to the end of the field with the DUP fill.
    //
    // tn5250 stores EBCDIC 0x1C here and transmits it verbatim on the next read
    // (display.c kf_dup; the host duplicates the prior record's value). We use
    // the U+001C sentinel in the local cell buffer: sendAID transmits it as text
    // and the server's toRemoteRune maps U+001C -> EBCDIC 0x1C regardless of code
    // page, so the host receives a real DUP. It renders blank (like tn5250's
    // curses terminal, which draws control bytes as blanks).
    for (let pos = cursorAddr; pos !== fEnd; pos = (pos + 1) % size) {
        cells[pos].c = "";
    }

    fieldMDT[f.addr] = true;
    repaintField(f);

    // FER field: hold the cursor at the last data cell and set the inhibit
    // (kf_dup: is_fer -> IND_FER + cursor to field end).
    if (f.fer) {
        const oldCursor = cursorAddr;
        cursorAddr = (fEnd - 1 + size) % size;
        moveCursorDOM(oldCursor, cursorAddr);
        setFER();
        return;
    }

    if (f.auto) {
        sendAID("Enter");
        return;
    }
    const oldCursor = cursorAddr;
    const nf = nextFieldAfter(f, fEnd);
    if (nf >= 0) cursorAddr = nf;
    moveCursorDOM(oldCursor, cursorAddr);
}

// ── AID key sending ─────────────────────────────────────────────────

// Short-read AIDs: AID sent without modified field data. On 5250 the
// Clear/Help/Print/RollUp/RollDown keys send an AID with the cursor but do
// not require field data. We keep the local buffer handling simple: only
// "Clear" clears the local screen buffer (see sendAID below).
const SHORT_READ_AIDS = new Set(["Clear"]);

// fieldContent returns a field's current cell contents as a string, with null
// cells represented as \0 (so blanks vs nulls can be distinguished).
function fieldContent(f) {
    const size = rows * cols;
    const start = f.addr % size;
    let s = "";
    for (let i = 0; i < f.len; i++) {
        const cc = cells[(start + i) % size].c;
        s += (cc === "" || cc === undefined) ? "\0" : cc;
    }
    return s;
}

// checkMandatory enforces mandatory-entry and mandatory-fill before Enter, like
// tn5250 (display.c). Returns false — reporting an operator error and moving the
// cursor to the offending field — if a constraint is violated. Modulo-10/11
// self-check digits are NOT validated locally; the host still validates on submit.
function checkMandatory() {
    const size = rows * cols;
    for (const f of fields) {
        if (f.prot) continue;
        const content = fieldContent(f);
        const hasData = /[^\0 ]/.test(content);
        if (f.mand && !hasData) {                       // mandatory-entry, empty
            cursorAddr = f.addr % size;
            renderScreen();
            oiaOperatorError("X Mandatory");
            return false;
        }
        if (f.adj === 7 && hasData && /[\0 ]/.test(content)) { // mandatory-fill, not full
            cursorAddr = f.addr % size;
            renderScreen();
            oiaOperatorError("X Fill");
            return false;
        }
    }
    return true;
}

function sendAID(aidName) {
    if (!ws || !connected) return;
    if (kbdLocked && aidName !== "Clear") return;

    // Mandatory-entry / mandatory-fill are enforced on Enter before transmitting.
    if (aidName === "Enter" && !checkMandatory()) return;

    // Any AID key (Enter, Field±, PF, …) releases a pending FER inhibit, matching
    // the FER-allowed key list in display.c do_key.
    clearFER();

    // Any AID key exits Insert mode, matching real 5250 hardware.
    if (insertMode) {
        insertMode = false;
        updateStatusBar();
    }

    // Clear key: clear local screen buffer before sending (like x3270's ctlr_clear)
    if (aidName === "Clear") {
        const size = rows * cols;
        for (let i = 0; i < size && i < cells.length; i++) {
            cells[i].c = " ";
            cells[i].fg = "green";
            cells[i].bg = "";
            cells[i].hi = "";
            cells[i].prot = false;
            cells[i].hid = false;
            cells[i].int = false;
        }
        cursorAddr = 0;
        fields = [];  // screen becomes unformatted after Clear
        fieldMDT = {};
        renderScreen();
    }

    // Collect modified field data (not for short-read AIDs)
    const modifiedFields = [];
    if (!SHORT_READ_AIDS.has(aidName)) {
        for (const f of fields) {
            if (f.prot) continue;
            if (!fieldMDT[f.addr]) continue;

            const size = rows * cols;
            const start = f.addr % size;
            let data = "";
            for (let i = 0; i < f.len; i++) {
                const addr = (start + i) % size;
                const cc = cells[addr] ? cells[addr].c : "";
                if (cc === "" || cc === undefined) {
                    data += "\0"; // null cell — will be stripped
                } else {
                    data += cc;
                }
            }
            // Strip trailing nulls like x3270 (skips 0x00 bytes).
            // Then strip trailing spaces for clean transmission.
            data = data.replace(/\0+$/, ""); // strip trailing nulls
            data = data.replace(/\0/g, "");  // skip embedded nulls (like x3270)
            data = data.replace(/ +$/, "");  // strip trailing spaces

            modifiedFields.push({ addr: f.addr, data: data });
        }
    }

    const msg = {
        type: "aid",
        aid: aidName,
        cursor: { row: Math.floor(cursorAddr / cols), col: cursorAddr % cols },
        fields: modifiedFields
    };

    ws.send(JSON.stringify(msg));

    // Lock keyboard and show wait indicator
    kbdLocked = true;
    lastHostCursor = -1; // allow host to reposition cursor in its response
    oiaWait(true);

    // Match x3270/c3270 semantics (Common/kybd.c:key_AID): on AID, lock
    // the keyboard (done above) but do NOT erase the typed cells. The
    // host's response repaints via the delta / full-screen handlers, and
    // renderScreen()'s cells-vs-renderedCells diff picks up whatever the
    // host actually changes. If the host doesn't address the input field,
    // the typed text stays visible during X Wait — c3270/x3270 only clear
    // ea_buf cells when the host issues an Erase command (ctlr.c: EAU /
    // WCC reset-MDT). Previously we wiped cells locally here, which caused
    // a visible "input vanishes, then host response paints" flicker.
    //
    // Reset the MDT map: those modifications have just been transmitted.
    // Short-read AIDs send no field data, so leave MDT alone.
    if (!SHORT_READ_AIDS.has(aidName)) {
        fieldMDT = {};
    }
}

// ── Keyboard handling ───────────────────────────────────────────────

function getKeyId(e) {
    // Right-side modifier keys are standalone mappable keys
    if (e.code === "AltRight") return "RightAlt";
    if (e.code === "MetaRight") return "RightMeta";
    if (e.code === "AltLeft" && e.key === "Alt") return null; // ignore left-side modifier alone
    if (e.code === "MetaLeft" && e.key === "Meta") return null;

    // Don't include modifier-only keys as the main key
    if (["Control","Shift","Alt","Meta"].includes(e.key)) return null;

    let parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    if (e.metaKey) parts.push("Meta");

    parts.push(e.key);
    return parts.join("+");
}

// Track Shift release / Caps-lock changes so the OIA "A" indicator turns off.
termEl.addEventListener("keyup", trackShift);

termEl.addEventListener("keydown", function(e) {
    trackShift(e); // keep the OIA keyboard-shift ("A") indicator current

    // Let native copy/paste/cut (Cmd+C/V/X or Ctrl+C/V/X) pass through
    if ((e.metaKey || e.ctrlKey) && ["c","v","x","a"].includes(e.key.toLowerCase())) return;

    // Any other key dismisses a lingering selection so cells held frozen by the
    // render skip don't stay stale when the user navigates by keyboard only.
    // Skip while a Meta/Ctrl modifier is held — including the bare modifier
    // keydown that arrives just before Cmd/Ctrl+C — so keyboard copy keeps its
    // selection intact for the copy handler.
    if (!e.metaKey && !e.ctrlKey) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed &&
            (termEl.contains(sel.anchorNode) || termEl.contains(sel.focusNode))) {
            sel.removeAllRanges();
            renderedCells = null;
            renderScreen();
        }
    }

    // Prevent browser defaults for function keys, modifiers, etc.
    if (e.key.startsWith("F") && e.key.length <= 3) e.preventDefault();
    if (e.key === "Tab" || e.key === "Escape" || e.key === "Enter" || e.key === "Home" || e.key === "Insert" || e.key === "End") e.preventDefault();
    if (e.key === "PageUp" || e.key === "PageDown") e.preventDefault();
    if (e.ctrlKey || e.altKey || e.metaKey) e.preventDefault();
    if (e.code === "AltRight" || e.code === "MetaRight") e.preventDefault();

    const keyId = getKeyId(e);
    if (!keyId) return;

    // Check keymap for AID key
    const fn = keymap[keyId];
    if (fn && AID_KEYS.has(fn)) {
        e.preventDefault();
        sendAID(fn);
        return;
    }

    // Check keymap for local actions (not sent to host)
    if (fn && LOCAL_ACTIONS.has(fn)) {
        e.preventDefault();
        switch (fn) {
        case "NewLine":
            newLine();
            break;
        case "Reset":
            // Reset / Error-Reset: clear the operator-error inhibit ("X II"),
            // FER inhibit, insert mode, and any local keyboard lock (local only).
            kbdLocked = false;
            insertMode = false;
            kbdInhibit = false;
            operatorErrMsg = "";
            clearFER();
            updateStatusBar();
            renderScreen();
            break;
        case "EraseEOF":
            eraseEOF();
            break;
        case "Home":
            firstUnprotectedField();
            break;
        case "Insert":
            insertMode = !insertMode;
            updateStatusBar();
            break;
        case "FieldExit":
            fieldExit();      // instant LOCAL operation — no round-trip
            break;
        case "FieldPlus":
            fieldPlus();      // instant LOCAL operation — no round-trip
            break;
        case "FieldMinus":
            fieldMinus();     // instant LOCAL operation — no round-trip
            break;
        case "Dup":
            dupField();       // instant LOCAL operation — no round-trip
            break;
        }
        return;
    }

    // Reset key (Ctrl+R or Alt+R): unlock keyboard and clear errors
    if (keyId === "Ctrl+r" || keyId === "Alt+r") {
        e.preventDefault();
        kbdLocked = false;
        insertMode = false;   // Reset also exits Insert mode
        clearFER();           // Reset also clears the FER inhibit
        oiaWait(false);
        updateStatusBar();
        renderScreen();
        return;
    }

    // Navigation keys (not remappable) — allowed even when keyboard is locked.
    // Arrows and Tab/Backtab release a pending FER inhibit (do_key FER list).
    switch (e.key) {
    case "Tab":
        e.preventDefault();
        clearFER();
        if (e.shiftKey) prevUnprotectedField();
        else nextUnprotectedField();
        return;
    case "ArrowLeft":
        e.preventDefault();
        clearFER();
        { const old = cursorAddr;
          cursorAddr = (cursorAddr - 1 + rows * cols) % (rows * cols);
          moveCursorDOM(old, cursorAddr); }
        return;
    case "ArrowRight":
        e.preventDefault();
        clearFER();
        { const old = cursorAddr;
          cursorAddr = (cursorAddr + 1) % (rows * cols);
          moveCursorDOM(old, cursorAddr); }
        return;
    case "ArrowUp":
        e.preventDefault();
        clearFER();
        { const old = cursorAddr;
          cursorAddr = (cursorAddr - cols + rows * cols) % (rows * cols);
          moveCursorDOM(old, cursorAddr); }
        return;
    case "ArrowDown":
        e.preventDefault();
        clearFER();
        { const old = cursorAddr;
          cursorAddr = (cursorAddr + cols) % (rows * cols);
          moveCursorDOM(old, cursorAddr); }
        return;
    case "Backspace":
        e.preventDefault();
        backspace();
        return;
    case "Delete":
        e.preventDefault();
        deleteChar();
        return;
    }

    // Regular character input
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        typeChar(e.key);
    }
});

// ── Copy/Paste support ──────────────────────────────────────────────

// Copy: intercept the clipboard write and build clean text from the
// selected cell range, inserting newlines at row boundaries.
termEl.addEventListener("copy", function(e) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;

    // Find the address range of selected spans
    const range = sel.getRangeAt(0);
    const spans = termEl.querySelectorAll("span");
    let startAddr = -1, endAddr = -1;

    for (let i = 0; i < spans.length; i++) {
        if (sel.containsNode(spans[i], true)) {
            if (startAddr === -1) startAddr = i;
            endAddr = i;
        }
    }

    if (startAddr < 0 || endAddr < 0) return;

    // Build clean text from the cells array
    let text = "";
    let lastRow = Math.floor(startAddr / cols);
    for (let i = startAddr; i <= endAddr && i < cells.length; i++) {
        const r = Math.floor(i / cols);
        if (r !== lastRow) {
            // Trim trailing spaces from previous line, add newline
            text = text.replace(/ +$/, "") + "\n";
            lastRow = r;
        }
        const ch = cells[i] ? (cells[i].c || " ") : " ";
        text += ch;
    }
    text = text.replace(/ +$/, ""); // trim trailing spaces on last line

    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
});

// Paste: read clipboard text and type each character into the terminal
// through the existing typeChar() function, respecting field boundaries.
// Newlines advance the cursor to the next line's first unprotected field
// (x3270 auto_skip behavior) and tabs move to the next unprotected field.
termEl.addEventListener("paste", function(e) {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    if (kbdLocked) return; // abort paste while keyboard is locked, like x3270

    for (const ch of text) {
        if (ch === "\n") { newLine(); continue; }          // move to next line (auto_skip)
        if (ch === "\r") { continue; }                       // ignore CR, like x3270
        if (ch === "\t") { nextUnprotectedField(); continue; } // tab to next field
        if (ch.length === 1 && ch >= " ") {
            typeChar(ch);
        }
    }
});

// Left mouse button clears any active selection and forces one clean full
// repaint — this both wipes stray ghost-highlight paint and lets the cells that
// were held frozen (see renderScreen) catch up to the live screen. Only acts
// when a real selection exists so ordinary clicks don't trigger a full repaint.
termEl.addEventListener("mousedown", function (e) {
    if (e.button !== 0) return; // left button only
    if (e.shiftKey) return;     // shift+click extends the selection — don't clear it
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        sel.removeAllRanges();
        renderedCells = null;
        renderScreen();
    }
});

// Focus terminal on click
termEl.addEventListener("click", function(e) {
    termEl.focus();
    // Click to position cursor
    const span = e.target.closest("span");
    if (span && span.dataset.addr !== undefined) {
        const oldCursor = cursorAddr;
        cursorAddr = parseInt(span.dataset.addr);
        moveCursorDOM(oldCursor, cursorAddr);
    }
});

// Auto-focus
document.addEventListener("DOMContentLoaded", function() {
    termEl.focus();
});

// ── Focus-state indicator ──────────────────────────────────────────
// Toggle .unfocused on #terminal-wrap whenever the terminal is not the
// active element, the browser window is blurred, or the tab is hidden.
// CSS dims the border so the user can see at a glance that keystrokes
// will not be received by the terminal.
function updateFocusState() {
    const tabHidden   = document.hidden;
    const winFocused  = document.hasFocus();
    const termFocused = (document.activeElement === termEl);
    const focused     = !tabHidden && winFocused && termFocused;

    const wrap = document.getElementById("terminal-wrap");
    if (wrap) {
        wrap.classList.toggle("unfocused", !focused);
    }

    // Returning to this tab/window clears any background-activity flash.
    if (!tabHidden && winFocused) {
        stopTabFlash();
    }
}

window.addEventListener("focus",   updateFocusState);
window.addEventListener("blur",    updateFocusState);
termEl.addEventListener("focus",   updateFocusState);
termEl.addEventListener("blur",    updateFocusState);
document.addEventListener("visibilitychange", updateFocusState);
document.addEventListener("DOMContentLoaded", updateFocusState);

// ── Background-activity tab title flash ─────────────────────────────
// When this browser tab is NOT in the foreground and its 5250 session
// receives a substantial screen update (> threshold cells changed),
// blink the browser-tab title so the user notices activity in another
// tab. Cleared automatically when the tab regains focus.
const TAB_BASE_TITLE         = document.title;   // "Web5250 Terminal"
const TAB_ALERT_PREFIX       = "● ACTIVITY — ";
const TAB_ACTIVITY_THRESHOLD = 10;               // > this many cells = activity
let   tabFlashTimer = null;
let   tabFlashOn    = false;

function tabIsForeground() {
    return !document.hidden && document.hasFocus();
}

function flashTabTitle() {
    if (tabFlashTimer) return;   // already flashing — don't stack timers
    tabFlashOn = true;
    document.title = TAB_ALERT_PREFIX + TAB_BASE_TITLE;
    tabFlashTimer = setInterval(function () {
        tabFlashOn = !tabFlashOn;
        document.title = tabFlashOn ? (TAB_ALERT_PREFIX + TAB_BASE_TITLE)
                                    : TAB_BASE_TITLE;
    }, 1000);
}

function stopTabFlash() {
    if (tabFlashTimer) { clearInterval(tabFlashTimer); tabFlashTimer = null; }
    document.title = TAB_BASE_TITLE;
    tabFlashOn = false;
}

// Pause/resume auto-reconnect based on tab visibility so a backgrounded tab
// stops hammering the server while still reconnecting promptly on return.
function handleVisibilityForReconnect() {
    if (document.hidden) {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
            const msgEl = document.getElementById("status-msg");
            if (msgEl) {
                msgEl.textContent = "Reconnect paused (tab hidden)";
                msgEl.style.color = "#e0d561";
            }
        }
    } else if (autoReconnect && !connected && !reconnectTimer) {
        doConnect();
    }
}
document.addEventListener("visibilitychange", handleVisibilityForReconnect);

// ── WebSocket communication ─────────────────────────────────────────

function doConnect() {
    // Cancel any pending auto-reconnect
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    const btn = document.getElementById("btn-connect");

    if (connected) {
        // Disconnect — disable auto-reconnect for manual disconnect
        const savedAR = autoReconnect;
        autoReconnect = false;
        if (ws) {
            ws.send(JSON.stringify({ type: "disconnect" }));
            ws.close();
        }
        setDisconnected();
        autoReconnect = savedAR;
        return;
    }

    const host = document.getElementById("host-input").value || "localhost";
    const port = document.getElementById("port-input").value || "23";
    const model = document.getElementById("model-select").value;
    const codepage = document.getElementById("codepage-select").value;

    // Save connection preferences
    localStorage.setItem("web5250-host", host);
    localStorage.setItem("web5250-port", port);
    localStorage.setItem("web5250-model", model);
    localStorage.setItem("web5250-codepage", codepage);

    // Save to connection history (last 10)
    saveConnectionToHistory(host, port, model, codepage, currentTheme);

    // Update grid for selected model (5250 terminal types)
    //   3179-2 = 24×80 (default),  3477-FC = 27×132
    const dims = { "3179-2": [24,80], "3477-FC": [27,132] };
    let customRows = 0, customCols = 0;
    if (model === "custom") {
        customRows = parseInt(document.getElementById("custom-rows").value) || 62;
        customCols = parseInt(document.getElementById("custom-cols").value) || 160;
        customRows = Math.max(24, Math.min(200, customRows));
        customCols = Math.max(80, Math.min(250, customCols));
        rows = customRows;
        cols = customCols;
        localStorage.setItem("web5250-custom-rows", customRows);
        localStorage.setItem("web5250-custom-cols", customCols);
    } else {
        const d = dims[model] || [24, 80];
        rows = d[0];
        cols = d[1];
    }
    buildGrid();

    // Connect WebSocket
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/web5250/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
        // Send connect request
        const connectMsg = {
            type: "connect",
            host: host,
            port: port,
            model: model,
            codepage: codepage
        };
        if (model === "custom") {
            connectMsg.customRows = customRows;
            connectMsg.customCols = customCols;
        }
        ws.send(JSON.stringify(connectMsg));
    };

    ws.onmessage = function(evt) {
        const msg = JSON.parse(evt.data);

        switch (msg.type) {
        case "delta":
        case "screen":
            rows = msg.rows;
            cols = msg.cols;

            // How many cells does this update change? Drives background-tab activity flash.
            let changedCells = 0;
            {
                if (msg.type === "delta") {
                    changedCells = (msg.delta || []).length;
                } else {
                    const nc = msg.cells || [];
                    if (cells.length === nc.length) {
                        for (let ci = 0; ci < nc.length; ci++) {
                            if (!cells[ci] || cells[ci].c !== nc[ci].c) changedCells++;
                        }
                    } else {
                        changedCells = nc.length; // first paint / resize → treat as substantial
                    }
                }
            }

            if (msg.type === "delta") {
                // Delta update: apply only changed cells to existing array.
                // The render function diffs cells[] against renderedCells[]
                // (x3270-style), so we just update cells[] here — no dirty
                // tracking needed. Immune to coalescing/batching issues.
                const dc = msg.delta || [];
                for (let di = 0; di < dc.length; di++) {
                    const d = dc[di];
                    if (d.a < cells.length) {
                        cells[d.a] = { c: d.c, fg: d.fg, bg: d.bg, hi: d.hi,
                                       prot: d.prot, hid: d.hid, int: d.int };
                    }
                }
            } else {
                // Full screen: preserve locally-typed content in modified fields.
                // Like a real 5250 terminal, user input lives in the local buffer
                // and is only overwritten when the host explicitly addresses those
                // positions. The server buffer doesn't have the user's keystrokes,
                // so a Write command (without Erase) would wipe them if we replaced
                // cells wholesale.
                if (cells.length === msg.cells.length && Object.keys(fieldMDT).length > 0) {
                    const newFields = msg.fields || [];
                    for (let fi = 0; fi < newFields.length; fi++) {
                        const nf = newFields[fi];
                        if (nf.prot) continue;
                        if (!fieldMDT[nf.addr]) continue;

                        // This field was locally modified — preserve user's chars
                        const size = rows * cols;
                        const start = nf.addr % size;
                        for (let j = 0; j < nf.len; j++) {
                            const addr = (start + j) % size;
                            msg.cells[addr].c = cells[addr].c;
                        }
                    }
                }

                cells = msg.cells;
                renderedCells = null; // force full repaint on next render
            }

            fields = msg.fields || [];

            // Enhanced (GUI) overlays. These arrive on every frame while a
            // construct is live and are omitted once it is gone, so replacing
            // them wholesale each frame keeps the overlay in step with the host.
            guiWindows = msg.windows || [];
            guiSelections = msg.selections || [];
            guiScrollbars = msg.scrollbars || [];

            // Cursor positioning (tn5250 model): the 5250 host is always
            // authoritative about the cursor. At the end of each Write-To-
            // Display, tn5250 homes the cursor to the IC target (if an IC order
            // was sent) or to the first non-bypass field, and the emulator draws
            // it there. Unlike 3270 there are no background refreshes to guard
            // against — the engine emits a frame only when the host sends data —
            // so always honor the host cursor position.
            if (msg.cursorSet) {
                cursorAddr = msg.cursor.row * cols + msg.cursor.col;
                lastHostCursor = cursorAddr;
            }

            // Rebuild grid if dimensions changed
            const currentSpans = termEl.querySelectorAll("span").length;
            if (currentSpans !== rows * cols) {
                window.getSelection().removeAllRanges();
                buildGrid();
            }

            // Host-driven keyboard state + OIA. kbdRestore set => keyboard
            // unlocked (ready); clear => host is inhibiting input ("X SYSTEM").
            // The post-AID wait is the same locked state, shown as X SYSTEM too.
            kbdLocked = !msg.kbdRestore;
            ferActive = false; // a fresh host frame carries new fields — reset any FER inhibit
            // When the host restores the keyboard it also ends any operator-error
            // inhibit ("X II") — mirror tn5250 so a stale kbdInhibit can't silently
            // keep swallowing keystrokes after the host says input is allowed again.
            if (msg.kbdRestore) { kbdInhibit = false; operatorErrMsg = ""; }
            // Capture the host-driven OIA indicator bits; updateOIA renders them.
            hostMW = !!msg.mw;
            hostXSystem = !!msg.xsys;
            hostXClock = !!msg.xclock;
            hostInhibit = !!msg.inhibit;
            updateOIA();

            if (false && msg.alarm) { // bell disabled — set to msg.alarm to re-enable
                try {
                    const ctx = new (window.AudioContext || window.webkitAudioContext)();
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.frequency.value = 800;
                    gain.gain.value = 0.3;
                    osc.start();
                    osc.stop(ctx.currentTime + 0.15);
                } catch(e) {}
            }
            // Flash this tab's title if a substantial update landed while the
            // user is looking at a different tab/window.
            if (changedCells > TAB_ACTIVITY_THRESHOLD && !tabIsForeground()) {
                flashTabTitle();
            }
            scheduleRender();
            break;

        case "status":
            const statusEl = document.getElementById("status-conn");
            const msgEl = document.getElementById("status-msg");

            if (msg.status === "connected") {
                setConnected();
            } else if (msg.status === "disconnected") {
                setDisconnected();
            } else if (msg.status === "locked") {
                lockHostPort(msg.host, msg.port);
            } else if (msg.status === "error") {
                msgEl.textContent = msg.message;
                msgEl.style.color = "#f44747";
            }

            if (msg.message && msg.status !== "error") {
                msgEl.dataset.baseMsg = msg.message;
                msgEl.textContent = msg.message;
                msgEl.style.color = "#aaa";
                if (connectedAt) updateUptime();
            }
            break;
        }
    };

    ws.onclose = function() {
        setDisconnected();
    };

    ws.onerror = function() {
        setDisconnected();
        document.getElementById("status-msg").textContent = "WebSocket error";
    };
}

var connectedAt = null;
var uptimeInterval = null;

function setConnected() {
    connected = true;
    connectedAt = Date.now();
    const btn = document.getElementById("btn-connect");
    btn.textContent = "Disconnect";
    btn.className = "disconnect";
    document.getElementById("status-conn").textContent = "Connected";
    document.getElementById("status-conn").className = "status-connected";
    oiaDisconnected(false);
    updateUptime();
    uptimeInterval = setInterval(updateUptime, 60000);
    termEl.focus();
}

function updateUptime() {
    if (!connectedAt) return;
    const el = document.getElementById("status-msg");
    const sec = Math.floor((Date.now() - connectedAt) / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    let str = "";
    if (d > 0) str = d + (d === 1 ? " day " : " days ") + h + (h === 1 ? " hour " : " hours ") + m + (m === 1 ? " min" : " mins");
    else if (h > 0) str = h + (h === 1 ? " hour " : " hours ") + m + (m === 1 ? " min" : " mins");
    else str = m + (m === 1 ? " min" : " mins");
    const msgEl = el;
    const base = msgEl.dataset.baseMsg || "";
    msgEl.textContent = base ? base + "  connection time: " + str : "connection time: " + str;
    msgEl.style.color = "#aaa";
}

function setDisconnected() {
    connected = false;
    connectedAt = null;
    if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
    const msgEl = document.getElementById("status-msg");
    if (msgEl) { msgEl.dataset.baseMsg = ""; }
    const btn = document.getElementById("btn-connect");
    btn.textContent = "Connect";
    btn.className = "";
    document.getElementById("status-conn").textContent = "Disconnected";
    document.getElementById("status-conn").className = "status-disconnected";
    oiaDisconnected(true);

    // Reset all local state to prevent stale data on reconnect
    fieldMDT = {};
    kbdLocked = false;
    ferActive = false;
    kbdInhibit = false;  // clear any persistent operator-error inhibit ("X II") so a reconnect never inherits a stale keyboard lock
    operatorErrMsg = "";
    hostMW = false; hostXSystem = false; hostXClock = false; hostInhibit = false;
    lastHostCursor = -1;
    insertMode = false;
    cursorAddr = 0;
    fields = [];
    spanCache = null;
    updateStatusBar();   // clear OIA "INS" / reset mode display on disconnect

    // Auto-reconnect after a short delay — but only when the tab is visible.
    // A hidden tab waits for visibilitychange to resume.
    if (autoReconnect && !reconnectTimer) {
        const msgEl2 = document.getElementById("status-msg");
        if (document.hidden) {
            if (msgEl2) {
                msgEl2.textContent = "Reconnect paused (tab hidden)";
                msgEl2.style.color = "#e0d561";
            }
        } else {
            if (msgEl2) {
                msgEl2.textContent = "Reconnecting in 3s...";
                msgEl2.style.color = "#e0d561";
            }
            reconnectTimer = setTimeout(function() {
                reconnectTimer = null;
                if (autoReconnect && !connected) {
                    doConnect();
                }
            }, 3000);
        }
    }
}

function lockHostPort(host, port) {
    const hostEl = document.getElementById("host-input");
    const portEl = document.getElementById("port-input");
    if (host) hostEl.value = host;
    if (port) portEl.value = port;
    hostEl.disabled = true;
    portEl.disabled = true;
    hostEl.style.opacity = "0.5";
    portEl.style.opacity = "0.5";
}

// ── Keyboard remapping UI ───────────────────────────────────────────

let listeningFor = null; // which function we're capturing a key for

function openSettings() {
    // Sync auto-reconnect checkbox
    const arCheckbox = document.getElementById("auto-reconnect");
    if (arCheckbox) {
        arCheckbox.checked = autoReconnect;
        arCheckbox.onchange = function() {
            autoReconnect = this.checked;
            localStorage.setItem("web5250-autoreconnect", autoReconnect ? "1" : "0");
        };
    }
    buildThemeList();
    const list = document.getElementById("keymap-list");
    list.innerHTML = "";

    // Build reverse map: function → key
    const fnToKey = {};
    for (const [key, fn] of Object.entries(keymap)) {
        fnToKey[fn] = key;
    }

    for (const fn of ALL_FUNCTIONS) {
        const row = document.createElement("div");
        row.className = "keymap-row";

        const label = document.createElement("span");
        label.className = "keymap-fn";
        label.textContent = fn;

        const keyBtn = document.createElement("span");
        keyBtn.className = "keymap-key";
        keyBtn.textContent = fnToKey[fn] || "(unassigned)";
        keyBtn.dataset.fn = fn;

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "keymap-cancel";
        cancelBtn.textContent = "Reset";
        cancelBtn.style.display = "none";
        cancelBtn.onclick = function(evt) {
            evt.stopPropagation();
            keyBtn.className = "keymap-key";
            keyBtn.textContent = fnToKey[fn] || "(unassigned)";
            cancelBtn.style.display = "none";
            listeningFor = null;
        };

        keyBtn.onclick = function() {
            // Cancel any previous listening
            if (listeningFor) {
                const prev = list.querySelector(".listening");
                if (prev) {
                    prev.className = "keymap-key";
                    prev.textContent = fnToKey[prev.dataset.fn] || "(unassigned)";
                }
                // Hide all cancel buttons
                list.querySelectorAll(".keymap-cancel").forEach(function(b) { b.style.display = "none"; });
            }
            listeningFor = fn;
            keyBtn.className = "keymap-key listening";
            keyBtn.textContent = "Press a key...";
            cancelBtn.style.display = "inline-block";
        };

        row.appendChild(label);
        row.appendChild(cancelBtn);
        row.appendChild(keyBtn);
        list.appendChild(row);
    }

    document.getElementById("modal-overlay").className = "visible";
}

function closeSettings() {
    document.getElementById("modal-overlay").className = "";
    listeningFor = null;
    termEl.focus();
}

function resetKeymap() {
    keymap = Object.assign({}, DEFAULT_KEYMAP);
    saveKeymap();
    openSettings(); // refresh display
}

// Listen for key events on the modal for remapping
document.addEventListener("keydown", function(e) {
    const modalOpen = document.getElementById("modal-overlay").classList.contains("visible");

    // When listening for a key mapping, capture ALL keys including Escape
    // and its modifier variants (Shift+Escape, Ctrl+Escape, etc.)
    if (modalOpen && e.key === "Escape" && !listeningFor) {
        // Escape closes the modal only when NOT listening for a key
        e.preventDefault();
        e.stopPropagation();
        closeSettings();
        return;
    }

    if (!listeningFor) return;

    e.preventDefault();
    e.stopPropagation();

    const keyId = getKeyId(e);
    if (!keyId) return;

    // Remove old mapping for this function
    for (const [k, v] of Object.entries(keymap)) {
        if (v === listeningFor) delete keymap[k];
    }

    // Set new mapping
    keymap[keyId] = listeningFor;
    saveKeymap();

    // Update display and hide cancel button
    const btn = document.querySelector(`[data-fn="${listeningFor}"]`);
    if (btn) {
        btn.className = "keymap-key";
        btn.textContent = keyId;
    }
    // Hide all cancel/reset buttons
    document.querySelectorAll(".keymap-cancel").forEach(function(b) { b.style.display = "none"; });

    listeningFor = null;
}, true);

// ── Font settings ───────────────────────────────────────────────────

function applyFont() {
    const fontFamily = document.getElementById("font-select").value;
    const fontSize = document.getElementById("fontsize-select").value;
    termEl.style.fontFamily = fontFamily;
    termEl.style.fontSize = fontSize + "px";
    localStorage.setItem("web5250-font", fontFamily);
    localStorage.setItem("web5250-fontsize", fontSize);
}

// ── Initialization ──────────────────────────────────────────────────

loadKeymap();

// Restore saved theme (always apply one so the cursor + theme CSS is injected,
// even on first visit / incognito where localStorage is empty)
let savedTheme = null;
try { savedTheme = localStorage.getItem("web5250-theme"); } catch (e) {}
applyTheme(savedTheme && THEMES[savedTheme] ? savedTheme : currentTheme);

// ── Connection history (last 10 hosts) ──────────────────────────────

const MAX_HISTORY = 10;

function loadConnectionHistory() {
    try {
        return JSON.parse(localStorage.getItem("web5250-history") || "[]");
    } catch(e) { return []; }
}

function saveConnectionToHistory(host, port, model, codepage, theme) {
    let history = loadConnectionHistory();
    const key = host + ":" + port;
    // Remove existing entry for same host:port
    history = history.filter(function(h) { return (h.host + ":" + h.port) !== key; });
    // Add to front
    history.unshift({ host: host, port: port, model: model, codepage: codepage, theme: currentTheme });
    // Keep max 10
    if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
    localStorage.setItem("web5250-history", JSON.stringify(history));
    populateHostDatalist();
}

function populateHostDatalist() {
    const dl = document.getElementById("host-history");
    if (!dl) return;
    dl.innerHTML = "";
    const history = loadConnectionHistory();
    for (const h of history) {
        const opt = document.createElement("option");
        opt.value = h.host;
        opt.label = h.host + ":" + h.port + " (" + h.model + ", CP" + (h.codepage || "37") + ")";
        opt.dataset.entry = JSON.stringify(h);
        dl.appendChild(opt);
    }
}

// When user selects from datalist, fill in all fields
document.addEventListener("DOMContentLoaded", function() {
    const hostInput = document.getElementById("host-input");
    if (hostInput) {
        hostInput.addEventListener("input", function() {
            const history = loadConnectionHistory();
            const match = history.find(function(h) { return h.host === hostInput.value; });
            if (match) {
                document.getElementById("port-input").value = match.port || "23";
                document.getElementById("model-select").value = match.model || "3179-2";
                if (match.codepage) {
                    document.getElementById("codepage-select").value = match.codepage;
                }
                if (match.theme && THEMES[match.theme]) {
                    applyTheme(match.theme);
                }
            }
        });
    }
});

// Restore auto-reconnect setting
if (localStorage.getItem("web5250-autoreconnect") === "1") {
    autoReconnect = true;
}

// Restore saved preferences from localStorage
const savedHost = localStorage.getItem("web5250-host");
const savedPort = localStorage.getItem("web5250-port");
const savedModel = localStorage.getItem("web5250-model");
const savedCodepage = localStorage.getItem("web5250-codepage");
const savedFont = localStorage.getItem("web5250-font");
const savedFontSize = localStorage.getItem("web5250-fontsize");
if (savedHost) document.getElementById("host-input").value = savedHost;
if (savedPort) document.getElementById("port-input").value = savedPort;
if (savedModel) document.getElementById("model-select").value = savedModel;
if (savedCodepage) document.getElementById("codepage-select").value = savedCodepage;

// Show/hide custom size inputs in the toolbar
function syncCustomSizeVisibility() {
    const el = document.getElementById("custom-size-toolbar");
    if (el) {
        el.style.display = document.getElementById("model-select").value === "custom" ? "inline" : "none";
    }
}
const savedCustomRows = localStorage.getItem("web5250-custom-rows");
const savedCustomCols = localStorage.getItem("web5250-custom-cols");
if (savedCustomRows) document.getElementById("custom-rows").value = savedCustomRows;
if (savedCustomCols) document.getElementById("custom-cols").value = savedCustomCols;
document.getElementById("model-select").addEventListener("change", syncCustomSizeVisibility);
syncCustomSizeVisibility();
if (savedFont) document.getElementById("font-select").value = savedFont;
if (savedFontSize) document.getElementById("fontsize-select").value = savedFontSize;
applyFont(); // apply saved font immediately

// URL params override saved preferences (e.g., ?port=2300&host=mainframe)
const params = new URLSearchParams(location.search);
if (params.get("host")) document.getElementById("host-input").value = params.get("host");
if (params.get("port")) document.getElementById("port-input").value = params.get("port");
if (params.get("model")) document.getElementById("model-select").value = params.get("model");
if (params.get("codepage")) document.getElementById("codepage-select").value = params.get("codepage");

// Server-injected version displayed in status bar
if (typeof WEB5250_VERSION !== "undefined") {
    document.getElementById("status-version").textContent = "web5250 v" + WEB5250_VERSION;
}

// Info button opens copyright modal
document.getElementById("info-btn").addEventListener("click", function() {
    document.getElementById("info-overlay").style.display = "flex";
});
document.getElementById("info-close-btn").addEventListener("click", function() {
    document.getElementById("info-overlay").style.display = "none";
});
document.getElementById("info-overlay").addEventListener("click", function(e) {
    if (e.target === this) this.style.display = "none";
});

// Server-injected model overrides saved/URL model
if (typeof WEB5250_MODEL !== "undefined") {
    document.getElementById("model-select").value = WEB5250_MODEL;
}

// Server-injected locked config overrides everything and auto-connects
if (typeof WEB5250_LOCKED_HOST !== "undefined" && typeof WEB5250_LOCKED_PORT !== "undefined") {
    lockHostPort(WEB5250_LOCKED_HOST, WEB5250_LOCKED_PORT);
}

buildGrid();
populateHostDatalist();

// Auto-connect in locked mode after grid is ready
if (typeof WEB5250_LOCKED_HOST !== "undefined" && typeof WEB5250_LOCKED_PORT !== "undefined") {
    setTimeout(function() { doConnect(); }, 100);
}
