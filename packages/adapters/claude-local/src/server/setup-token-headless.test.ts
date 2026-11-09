// Regression tests for headless `claude setup-token` sign-in (issue #17868).
// They use real PTY output captured inside the Paperclip Docker image plus a
// differential-redraw success screen modelled on the bytes in the issue.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  parseSetupTokenCredential,
  parseSetupTokenPrompt,
  SETUP_TOKEN_AFTER_ANCHOR,
  SETUP_TOKEN_BEFORE_ANCHOR,
  SETUP_TOKEN_PROMPT,
} from "./setup-token-parse.js";
import {
  CLAUDE_SETUP_TOKEN_PTY_COLUMNS,
  CLAUDE_SETUP_TOKEN_PTY_ROWS,
  CODE_SUBMISSION_TERMINATOR,
  runSetupTokenLogin,
  type SetupTokenPtyDriver,
} from "./setup-token-runner.js";
import { renderTerminalScreen } from "./terminal-screen.js";

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/setup-token-headless-2.1.306.json", import.meta.url), "utf8"),
) as { cols0: string; cols120: string };

const TERMINAL = { columns: CLAUDE_SETUP_TOKEN_PTY_COLUMNS, rows: CLAUDE_SETUP_TOKEN_PTY_ROWS };

const EXPECTED_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=user%3Ainference&code_challenge=CCCCCCCCCCCCCCCCCCCChallengeFixture01234567" +
  "&code_challenge_method=S256&state=SSSSSSSSSSSSSSSSSSSStateFixture0123456789ab";

const FAKE_TOKEN = `sk-ant-oat01-${"Ab3_Cd4-Ef5".repeat(8)}xyz`;

const CSI = "\x1b[";

/**
 * Builds a success screen the way Claude's differential renderer draws it: the
 * previous frame already holds some of the same characters in the same cells,
 * so the new frame skips them with Cursor Horizontal Absolute jumps and moves
 * between rows with Cursor Down instead of line feeds.
 */
function differentialSuccessStream(): string {
  const anchorRow = ` ${SETUP_TOKEN_BEFORE_ANCHOR}`;
  const afterRow = ` ${SETUP_TOKEN_AFTER_ANCHOR}`;
  // Cells the previous frame already holds with the right character.
  const skippedBefore = new Set([10, 34]); // the "t" in OAuth, the "a" in year
  const skippedAfter = new Set([22]); // the "o" in won't
  const previousFrame = (row: string, skipped: Set<number>) =>
    [...row].map((ch, index) => (skipped.has(index) ? ch : "·")).join("");
  const drawSkipping = (row: string, skipped: Set<number>) => {
    let out = "";
    for (let index = 0; index < row.length; index += 1) {
      if (skipped.has(index)) {
        out += `${CSI}${index + 2}G`; // jump past the cell that already matches
        continue;
      }
      out += row[index];
    }
    return out;
  };
  return [
    // Earlier frame: the rows that the new frame will partly reuse.
    `\r\n${previousFrame(anchorRow, skippedBefore)}\r\n\r\n\r\n\r\n${previousFrame(afterRow, skippedAfter)}`,
    // Move back up to the anchor row and redraw differentially.
    `${CSI}4A\r${drawSkipping(anchorRow, skippedBefore)}${CSI}K`,
    `\r${CSI}1B${CSI}K`,
    `\r${CSI}1B${CSI}2G${FAKE_TOKEN}${CSI}K`,
    `\r${CSI}1B${CSI}K`,
    `\r${CSI}1B${drawSkipping(afterRow, skippedAfter)}${CSI}K\r\n`,
  ].join("");
}

describe("headless setup-token sign-in (#17868)", () => {
  it("parses the real 0x0 container capture despite the native-copy hint", () => {
    expect(parseSetupTokenPrompt(fixture.cols0)).toEqual({ url: EXPECTED_URL, prompt: SETUP_TOKEN_PROMPT });
  });

  it("parses the real 120x40 container capture, raw and rendered", () => {
    expect(parseSetupTokenPrompt(fixture.cols120)).toEqual({ url: EXPECTED_URL, prompt: SETUP_TOKEN_PROMPT });
    const rendered = renderTerminalScreen(fixture.cols120, TERMINAL);
    expect(rendered).toContain("Hold Shift while selecting to use your terminal's native copy");
    expect(parseSetupTokenPrompt(rendered)).toEqual({ url: EXPECTED_URL, prompt: SETUP_TOKEN_PROMPT });
  });

  it("still fails closed for prose other than one native-copy hint", () => {
    const twoHints = fixture.cols0.replace(
      "Paste",
      "Hold Shift while selecting to use your terminal's native copy\r\n Paste",
    );
    expect(parseSetupTokenPrompt(twoHints)).toBeNull();
    const otherProse = fixture.cols0.replace("Hold", "Please");
    expect(parseSetupTokenPrompt(otherProse)).toBeNull();
  });

  it("reads a differentially redrawn success screen only through the rendered screen", () => {
    const stream = differentialSuccessStream();
    // The raw stream reads "Your OAuh token (valid for 1 yer):" after stripping.
    expect(parseSetupTokenCredential(stream)).toBeNull();
    expect(parseSetupTokenCredential(stream, TERMINAL)).toBe(FAKE_TOKEN);
  });

  it("does not bind a token without both rendered anchors", () => {
    const stream = differentialSuccessStream().replace(SETUP_TOKEN_AFTER_ANCHOR.slice(0, 10), "Something ");
    expect(parseSetupTokenCredential(stream, TERMINAL)).toBeNull();
  });

  it("completes a run end to end with the real prompt and a differential success screen", async () => {
    let emit: (chunk: string) => void = () => {};
    let finish: (code: number) => void = () => {};
    const writes: string[] = [];
    const driver: SetupTokenPtyDriver = {
      start(_command, onData) {
        emit = onData;
        return new Promise((resolve) => { finish = (exitCode) => resolve({ exitCode }); });
      },
      write(input) {
        writes.push(input);
        if (input === CODE_SUBMISSION_TERMINATOR) {
          setTimeout(() => {
            emit(differentialSuccessStream());
            finish(0);
          }, 0);
        }
      },
      stop() {},
      async dispose() {},
    };
    const onPrompt = vi.fn();
    const onCredential = vi.fn(async (_bytes: Buffer) => {});
    let delivered = "";
    onCredential.mockImplementation(async (bytes) => { delivered = bytes.toString("utf8"); });
    const run = runSetupTokenLogin(driver, {
      onPrompt,
      provideCode: async () => "BROWSER#CODE",
      onCredential,
      timeoutMs: 2000,
      codeSubmitSettleMs: 0,
      terminal: TERMINAL,
    });
    // Stream the real capture in small chunks, the way a PTY delivers it.
    for (let index = 0; index < fixture.cols120.length; index += 97) emit(fixture.cols120.slice(index, index + 97));
    const result = await run;
    expect(onPrompt).toHaveBeenCalledWith({ url: EXPECTED_URL, prompt: SETUP_TOKEN_PROMPT });
    expect(writes).toEqual(["BROWSER#CODE", CODE_SUBMISSION_TERMINATOR]);
    expect(result.outcome).toBe("success");
    expect(delivered).toBe(FAKE_TOKEN);
  });
});

describe("renderTerminalScreen", () => {
  it("applies cursor moves, erases, and deferred wrap", () => {
    expect(renderTerminalScreen("abc\r\ndef\x1b[1A\x1b[2Gx\x1b[K", { columns: 10, rows: 5 })).toBe("ax\ndef");
    expect(renderTerminalScreen("abcdefgh", { columns: 4, rows: 5 })).toBe("abcd\nefgh");
    expect(renderTerminalScreen("abcd\r\nx", { columns: 4, rows: 5 })).toBe("abcd\nx");
  });

  it("keeps the visible text of an OSC 8 hyperlink and drops the target", () => {
    const link = "\x1b]8;id=1;https://example.invalid/full\x07visible\x1b]8;;\x07";
    expect(renderTerminalScreen(link, { columns: 40, rows: 5 })).toBe("visible");
  });

  it("returns an empty string for invalid input", () => {
    expect(renderTerminalScreen(undefined as unknown as string, { columns: 10, rows: 5 })).toBe("");
    expect(renderTerminalScreen("abc", { columns: 0, rows: 5 })).toBe("");
  });
});
