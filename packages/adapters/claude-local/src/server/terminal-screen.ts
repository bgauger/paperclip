// A minimal, pure terminal screen model for the setup-token parsers.
//
// Claude Code renders its login UI with a differential renderer: it moves the
// cursor with relative CSI sequences, skips cells whose character is already on
// screen, and wraps long values at the terminal width. A parser that only strips
// control sequences from the raw byte stream then reads text the user never saw
// (for example `Your OAuh token (valid for 1 yer):`). This module replays the
// stream into a grid of cells and returns the text a user would see, one screen
// row per line, so the parsers can bind to the rendered screen instead.
//
// The model is intentionally small. It supports printable text with deferred
// auto-wrap, CR, LF, BS, HT, cursor movement (CUU, CUD, CUF, CUB, CNL, CPL, CHA,
// CUP, HVP, VPA), erase in line and erase in display, save and restore cursor,
// and scrolling at the bottom of the viewport. It drops OSC (including OSC 8
// hyperlink markup, keeping the visible text), DCS, APC, PM, SOS, SGR, and every
// other control sequence. Lines that scroll out of the viewport stay in the
// output, in order, so nothing the CLI printed is lost.
//
// Security: the function never logs input, never throws on input, and returns
// only characters that were present in the input.

export interface TerminalScreenOptions {
  /** The terminal width the producer saw. Wrapping depends on it. */
  columns: number;
  /** The terminal height the producer saw. Absolute row moves depend on it. */
  rows: number;
}

// Hard bounds that keep a hostile stream from allocating unbounded memory.
const MAX_COLUMNS = 1000;
const MAX_ROWS = 500;
const MAX_TOTAL_LINES = 5000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Replays `text` into a screen model and returns the rendered rows joined with
 * `\n`. Each row is right-trimmed. Returns an empty string for a non-string
 * input or invalid options.
 */
export function renderTerminalScreen(text: string, options: TerminalScreenOptions): string {
  if (typeof text !== "string" || text.length === 0) return "";
  const columns = Math.floor(options?.columns ?? 0);
  const rows = Math.floor(options?.rows ?? 0);
  if (!(columns > 0) || !(rows > 0)) return "";
  const cols = Math.min(columns, MAX_COLUMNS);
  const height = Math.min(rows, MAX_ROWS);

  const lines: string[][] = [[]];
  // The absolute index of the first line in the viewport.
  let top = 0;
  let row = 0;
  let col = 0;
  // Deferred wrap: the cursor sits past the last column until the next print.
  let wrapPending = false;
  let saved = { row: 0, col: 0 };

  const ensureRow = (index: number) => {
    while (lines.length <= index && lines.length < MAX_TOTAL_LINES) lines.push([]);
  };
  const lineFeed = () => {
    if (row - top >= height - 1) top += 1;
    row += 1;
    if (row >= MAX_TOTAL_LINES) row = MAX_TOTAL_LINES - 1;
    ensureRow(row);
  };
  const setRowInViewport = (relative: number) => {
    row = top + clamp(relative, 0, height - 1);
    ensureRow(row);
  };
  const eraseLine = (index: number, from: number, to: number) => {
    const line = lines[index];
    if (!line) return;
    for (let i = from; i < Math.min(to, line.length); i += 1) line[i] = " ";
  };

  let i = 0;
  const n = text.length;
  // Skips a string-type sequence (OSC, DCS, APC, PM, SOS) up to BEL or ST.
  const skipStringSequence = () => {
    while (i < n) {
      const c = text[i];
      if (c === "\x07") { i += 1; return; }
      if (c === "\x1b" && text[i + 1] === "\\") { i += 2; return; }
      i += 1;
    }
  };

  while (i < n) {
    const ch = text[i];
    if (ch === "\x1b") {
      const next = text[i + 1];
      if (next === "[") {
        // CSI: parameter bytes 0x30-0x3F, intermediate 0x20-0x2F, final 0x40-0x7E.
        let j = i + 2;
        let params = "";
        while (j < n && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) { params += text[j]; j += 1; }
        while (j < n && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j += 1;
        if (j >= n) break;
        const final = text[j];
        i = j + 1;
        // Private sequences (`?`, `<`, `=`, `>`) never move the cursor here.
        if (/^[<=>?]/.test(params)) continue;
        const parts = params.split(";").map((part) => (part === "" ? NaN : Number.parseInt(part, 10)));
        const p1 = Number.isFinite(parts[0]) ? parts[0] : NaN;
        const count = Number.isFinite(p1) && p1 > 0 ? p1 : 1;
        switch (final) {
          case "A": wrapPending = false; row = Math.max(top, row - count); break;
          case "B": wrapPending = false; setRowInViewport(row - top + count); break;
          case "C": wrapPending = false; col = Math.min(cols - 1, col + count); break;
          case "D": wrapPending = false; col = Math.max(0, col - count); break;
          case "E": wrapPending = false; setRowInViewport(row - top + count); col = 0; break;
          case "F": wrapPending = false; row = Math.max(top, row - count); col = 0; break;
          case "G": case "`": wrapPending = false; col = clamp(count - 1, 0, cols - 1); break;
          case "d": wrapPending = false; setRowInViewport(count - 1); break;
          case "H": case "f": {
            wrapPending = false;
            const r = Number.isFinite(parts[0]) && parts[0] > 0 ? parts[0] : 1;
            const c = Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : 1;
            setRowInViewport(r - 1);
            col = clamp(c - 1, 0, cols - 1);
            break;
          }
          case "K": {
            const mode = Number.isFinite(p1) ? p1 : 0;
            if (mode === 0) eraseLine(row, col, cols);
            else if (mode === 1) eraseLine(row, 0, col + 1);
            else if (mode === 2) eraseLine(row, 0, cols);
            break;
          }
          case "J": {
            const mode = Number.isFinite(p1) ? p1 : 0;
            if (mode === 0) {
              eraseLine(row, col, cols);
              for (let r = row + 1; r < lines.length; r += 1) eraseLine(r, 0, cols);
            } else if (mode === 1) {
              for (let r = top; r < row; r += 1) eraseLine(r, 0, cols);
              eraseLine(row, 0, col + 1);
            } else if (mode === 2) {
              for (let r = top; r < lines.length; r += 1) eraseLine(r, 0, cols);
            }
            break;
          }
          case "s": saved = { row, col }; break;
          case "u": row = saved.row; col = saved.col; wrapPending = false; ensureRow(row); break;
          default: break; // SGR and every other CSI final byte carry no layout.
        }
        continue;
      }
      if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
        i += 2;
        skipStringSequence();
        continue;
      }
      if (next === "7") { saved = { row, col }; i += 2; continue; }
      if (next === "8") { row = saved.row; col = saved.col; wrapPending = false; ensureRow(row); i += 2; continue; }
      if (next === "M") { wrapPending = false; row = Math.max(top, row - 1); i += 2; continue; }
      if (next === "D") { lineFeed(); i += 2; continue; }
      if (next === "E") { lineFeed(); col = 0; i += 2; continue; }
      // Any other two-byte escape (charset selection, keypad modes) carries no text.
      i += next === "(" || next === ")" || next === "*" || next === "+" || next === "#" ? 3 : 2;
      continue;
    }
    i += 1;
    if (ch === "\r") { col = 0; wrapPending = false; continue; }
    if (ch === "\n" || ch === "\v" || ch === "\f") { wrapPending = false; lineFeed(); continue; }
    if (ch === "\b") { wrapPending = false; col = Math.max(0, col - 1); continue; }
    if (ch === "\t") { col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8); continue; }
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    // Keep a surrogate pair together as one cell.
    let glyph = ch;
    if (code >= 0xd800 && code <= 0xdbff && i < n) { glyph += text[i]; i += 1; }
    if (wrapPending) {
      wrapPending = false;
      col = 0;
      lineFeed();
    }
    ensureRow(row);
    const line = lines[row];
    while (line.length < col) line.push(" ");
    line[col] = glyph;
    if (col >= cols - 1) wrapPending = true;
    else col += 1;
  }

  return lines.map((line) => line.join("").replace(/\s+$/, "")).join("\n");
}
