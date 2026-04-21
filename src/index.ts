/**
 * pi-extension-session-title
 *
 * Sole purpose: pin a user-configurable title somewhere always-visible while
 * pi is running, so you can tell different pi instances apart at a glance.
 *
 * --------------------------------------------------------------------------
 * Why this needs care: pi's TUI is inline-render
 * --------------------------------------------------------------------------
 *
 * Pi-tui does *not* use the alternate screen buffer and does *not* set a
 * DECSTBM scroll region. It writes its frame directly to your terminal's
 * normal scrollback area and emits real `\n`s to scroll when content grows
 * past the terminal height. That means:
 *
 *   - The *top* of pi's frame (custom header, first messages) eventually
 *     scrolls up into your terminal's scrollback as the conversation grows.
 *     `ctx.ui.setHeader()` is NOT sticky. An extension cannot make it sticky
 *     without deeply interfering with pi-tui internals.
 *
 *   - The *bottom* of pi's frame (editor + footer) is the only surface pi
 *     keeps anchored to the visible viewport, because pi positions the
 *     hardware cursor near the bottom on each render. `ctx.ui.setStatus()`
 *     writes into the footer and is sticky *relative to the current
 *     viewport* (mouse-wheel scrolling up still reveals old frames in
 *     scrollback — that's the terminal's behavior, not pi's).
 *
 *   - The OS terminal window/tab title is outside pi's content area
 *     entirely; it's drawn by your terminal emulator's chrome, never
 *     scrolls, and is always visible.
 *
 *   - Tmux has its own sticky status bar. If we detect $TMUX we can push
 *     the title into `tmux rename-window`, which shows up in any tmux
 *     status-bar template that references `#W`.
 *
 * So this extension offers four surfaces you can combine:
 *
 *   terminal   — OS window/tab title.     Always-sticky. (setTitle)
 *   tmux       — tmux window name.         Always-sticky inside tmux.
 *   divider    — horizontal rule with the   Claude-Code style. Sticky via
 *                title inlaid, rendered     pi's widget system (placed
 *                just above the editor.     above the editor, which pi
 *                                          anchors to the viewport
 *                                          bottom). Works in any terminal.
 *   footer     — pi footer status line.    Sticky to the bottom of pi's
 *                                          viewport. (setStatus)
 *   header     — colored bar at top of     NOT sticky — scrolls with
 *                pi's frame.                content. (setHeader)
 *   sticky     — fixed bar at terminal     Sticky via DECSTBM scroll
 *                row 1, via scroll region. region hack. Requires a modern
 *                                          VT-compliant terminal (Ghostty,
 *                                          iTerm2, Alacritty, Kitty,
 *                                          WezTerm, xterm). Does NOT work
 *                                          inside tmux (tmux owns the
 *                                          scroll region).
 *
 * Title is resolved on every `session_start` (and whenever a source
 * changes) with this priority:
 *   1. Runtime override set via `/title <name>`  (highest)
 *   2. `--title "<name>"` CLI flag
 *   3. `PI_SESSION_TITLE` environment variable
 *   4. LLM-generated auto-title (fires once per session, after the first
 *      turn that either ran a tool call OR accumulated >= 500 chars of
 *      user input). Opt out with `--no-auto-title` or
 *      `PI_SESSION_AUTO_TITLE=0`. Force regeneration with `/retitle`.
 *   5. Current git branch name, if inside a repo.
 *   6. Fallback: basename of the current working directory.
 */

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ENV_TITLE = "PI_SESSION_TITLE";
const ENV_STYLE = "PI_SESSION_TITLE_STYLE";
const ENV_POSITION = "PI_SESSION_TITLE_POSITION";

// Auto-title (LLM-generated) config env vars. See the top-of-file docstring
// for the resolution order.
const ENV_AUTO_TITLE = "PI_SESSION_AUTO_TITLE"; // 0/off/false/no disables
const ENV_AUTO_TITLE_MODEL = "PI_SESSION_AUTO_TITLE_MODEL"; // "provider/id"
const ENV_AUTO_TITLE_MODELS = "PI_SESSION_AUTO_TITLE_MODELS"; // comma list
const ENV_AUTO_TITLE_THRESHOLD = "PI_SESSION_AUTO_TITLE_THRESHOLD_CHARS";

const DEFAULT_AUTO_TITLE_THRESHOLD_CHARS = 500;
const AUTO_TITLE_MAX_TOKENS = 40;
const AUTO_TITLE_MAX_VISIBLE_WIDTH = 60;

// Ordered from "preferred for short, cheap output" to "still fine". First
// entry with resolved auth wins. Hard-coded lists rot; `PI_SESSION_AUTO_TITLE_MODELS`
// env override exists exactly for that.
const DEFAULT_AUTO_TITLE_MODELS: ReadonlyArray<readonly [string, string]> = [
	["google", "gemini-2.5-flash"],
	["anthropic", "claude-haiku-4-5"],
	["openai", "gpt-5-nano"],
	["openai", "gpt-4o-mini"],
];

const STATUS_KEY = "session-title";

const ALLOWED_SURFACES = ["terminal", "divider", "footer", "header", "tmux", "sticky"] as const;
type Surface = (typeof ALLOWED_SURFACES)[number];

// Theme bg tokens pi exposes (see `ThemeBg` in
// @mariozechner/pi-coding-agent, not re-exported from the public entry).
const THEME_BGS = [
	"customMessageBg",
	"userMessageBg",
	"selectedBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
] as const;
type ThemeBg = (typeof THEME_BGS)[number];

type Style = "inverse" | "plain" | `bg-${ThemeBg}`;
const ALLOWED_STYLES: readonly Style[] = [
	"inverse",
	"plain",
	...THEME_BGS.map((b) => `bg-${b}` as const),
];
const DEFAULT_STYLE: Style = "inverse";

function isStyle(v: string): v is Style {
	return (ALLOWED_STYLES as readonly string[]).includes(v);
}
function isSurface(v: string): v is Surface {
	return (ALLOWED_SURFACES as readonly string[]).includes(v);
}

function parsePosition(value: string | undefined): Surface[] | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const parts = trimmed
		.split(/[,\s]+/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	const out: Surface[] = [];
	for (const p of parts) {
		if (!isSurface(p)) return undefined;
		if (!out.includes(p)) out.push(p);
	}
	return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Auto-title: zero-LLM heuristics + module-level helpers
// ---------------------------------------------------------------------------

/**
 * Cached result of `git rev-parse --abbrev-ref HEAD`, sniffed lazily the
 * first time someone asks. `undefined` = not checked yet, `null` = checked
 * and not a repo / detached HEAD, `string` = branch name.
 *
 * We cache across the whole process lifetime because (a) `git` spawns are
 * not free and (b) branch changes during a pi session are rare and if they
 * do matter the user can `/title` or `/retitle` them away.
 */
let cachedGitBranch: string | null | undefined;

function getGitBranch(): string | undefined {
	if (cachedGitBranch !== undefined) return cachedGitBranch ?? undefined;
	try {
		const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 500,
			encoding: "utf8",
		}).trim();
		if (out.length === 0 || out === "HEAD") {
			cachedGitBranch = null;
			return undefined;
		}
		cachedGitBranch = out;
		return out;
	} catch {
		cachedGitBranch = null;
		return undefined;
	}
}

function parseAutoTitleThreshold(): number {
	const raw = process.env[ENV_AUTO_TITLE_THRESHOLD];
	if (!raw) return DEFAULT_AUTO_TITLE_THRESHOLD_CHARS;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_AUTO_TITLE_THRESHOLD_CHARS;
}

function parseModelList(raw: string | undefined): Array<[string, string]> | undefined {
	if (!raw) return undefined;
	const out: Array<[string, string]> = [];
	for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
		const idx = part.indexOf("/");
		if (idx <= 0 || idx === part.length - 1) continue;
		out.push([part.slice(0, idx), part.slice(idx + 1)]);
	}
	return out.length > 0 ? out : undefined;
}

/**
 * Sum the length of all `TextContent` parts in an AgentMessage's content.
 * Mirrors the extractor in the SDK's summarize.ts example, deliberately
 * ignoring image/tool-call parts so they don't inflate the char count and
 * accidentally trip the threshold on purely-tool-driven turns.
 */
function estimateTextLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const part of content) {
		if (part && typeof part === "object") {
			const p = part as { type?: string; text?: string };
			if (p.type === "text" && typeof p.text === "string") total += p.text.length;
		}
	}
	return total;
}

/** Return the first TextContent.text in a message content blob, if any. */
function extractFirstText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (part && typeof part === "object") {
			const p = part as { type?: string; text?: string };
			if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) return p.text;
		}
	}
	return undefined;
}

/**
 * Clean up a raw LLM response into something presentable as a title, or
 * return undefined if the response is unusable. Rejects empty output,
 * stuff that's too wide for the divider, and textbook refusal patterns
 * ("I'm sorry", "As an AI", ...) that would be confusing as a title.
 */
function sanitizeAutoTitle(raw: string): string | undefined {
	let s = raw.trim();
	const nl = s.indexOf("\n");
	if (nl >= 0) s = s.slice(0, nl).trim();
	s = s.replace(/\s+/g, " ");
	// Strip wrapping quotes (ASCII + curly) and any leading/trailing
	// punctuation the model tried to decorate the title with.
	s = s.replace(/^["'`\u201C\u2018]+/, "").replace(/["'`\u201D\u2019]+$/, "");
	s = s.replace(/^[\s.!?:;,\-]+/, "").replace(/[\s.!?:;,\-]+$/, "");
	if (s.length === 0) return undefined;
	if (visibleWidth(s) > AUTO_TITLE_MAX_VISIBLE_WIDTH) return undefined;
	if (/\b(i\s+(?:can['\u2019]t|cannot|am\s+unable)|as\s+an\s+ai|i['\u2019]?m\s+sorry)\b/i.test(s))
		return undefined;
	return s;
}

function buildAutoTitlePrompt(firstPrompt: string | undefined, sawToolCall: boolean): string {
	const trimmed = (firstPrompt ?? "").trim();
	// Hard cap the prompt we feed in — we only need the gist, and some
	// providers are miserly about context on nano-tier models.
	const clipped = trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}\u2026` : trimmed;
	return [
		"You are naming a coding-agent session so a user can tell it apart from other sessions at a glance.",
		"",
		"Rules:",
		"- 2 to 5 words.",
		"- Title Case.",
		"- No quotes, no trailing punctuation, no emoji.",
		'- Prefer the concrete task ("Fix Login Redirect") over the medium ("Python Help").',
		"- If the input is vague, return a one-word topic in Title Case.",
		"",
		"Output ONLY the title on a single line.",
		"",
		"<first-prompt>",
		clipped,
		"</first-prompt>",
		"",
		`<tool-usage>${sawToolCall ? "tool calls observed" : "no tool calls yet"}</tool-usage>`,
	].join("\n");
}

type AutoTitleStatus = "idle" | "pending" | "done" | "disabled" | "skipped";

interface AutoTitleState {
	status: AutoTitleStatus;
	userChars: number;
	sawToolCall: boolean;
	firstPrompt?: string;
	result?: string;
}

function resetAutoTitleState(state: AutoTitleState): void {
	state.status = "idle";
	state.userChars = 0;
	state.sawToolCall = false;
	state.firstPrompt = undefined;
	state.result = undefined;
}

function defaultPosition(): Surface[] {
	// Smart default:
	//   - terminal title is always useful
	//   - divider is Claude-Code style: a horizontal rule with the title
	//     inlaid, sitting right above the input field. Always visible
	//     because the editor is pinned to the viewport bottom.
	//   - if we're in tmux, also rename the tmux window so the title
	//     shows up in the tmux status bar (a real sticky top bar).
	const surfaces: Surface[] = ["terminal", "divider"];
	if (process.env.TMUX) surfaces.push("tmux");
	return surfaces;
}

// ---------------------------------------------------------------------------
// tmux helper
// ---------------------------------------------------------------------------

function updateTmuxWindowName(title: string): void {
	if (!process.env.TMUX) return;
	// Fire-and-forget; tmux rename-window is near-instant and can't fail in a
	// way we care about (wrong pane, no tmux, etc. — just ignore).
	try {
		const child = spawn("tmux", ["rename-window", title], {
			stdio: "ignore",
			detached: true,
		});
		child.unref();
		child.on("error", () => {
			/* ignore: tmux binary missing or exec failed */
		});
	} catch {
		/* ignore */
	}
}

/**
 * Shared styling function reused by header, sticky, and divider surfaces.
 */
function styleBarFor(line: string, style: Style, theme: ExtensionContext["ui"]["theme"]): string {
	switch (style) {
		case "inverse":
			return theme.inverse(theme.bold(line));
		case "plain":
			return theme.bold(theme.fg("accent", line));
		default: {
			const token = style.slice(3) as ThemeBg;
			return theme.bg(token, theme.bold(theme.fg("accent", line)));
		}
	}
}

/**
 * Render the Claude-Code style divider: a horizontal rule with the title
 * inlaid. Used by the `divider` surface (placed just above the editor).
 *
 * Example:  ─── π  Prod API ─────────────────────────────────────────────
 *
 * The style options determine how the line is colored:
 *   - `plain`  : border chars in `borderAccent`, label in bold accent.
 *                Subtle, readable; the default choice for this surface.
 *   - `inverse`: whole line is inverse-video (swapped fg/bg). Very loud
 *                but less divider-y.
 *   - `bg-*`   : whole line is painted with the given theme background.
 */
function renderDivider(title: string, width: number, borderColor: (str: string) => string): string {
	if (width <= 0) return "";

	const RULE = "\u2500"; // U+2500 BOX DRAWINGS LIGHT HORIZONTAL
	const rightCap = RULE.repeat(3);
	const rawTitle = title.trim();
	if (rawTitle.length === 0) return borderColor(RULE.repeat(width));

	// Right-aligned title, inlaid into the existing top border:
	//   ───────────────────────────────────────── title ───
	const suffixPrefix = " ";
	const suffixSuffix = ` ${rightCap}`;
	const suffixBudget = Math.max(0, width - visibleWidth(suffixPrefix) - visibleWidth(suffixSuffix));
	const safeTitle = truncateToWidth(rawTitle, suffixBudget);
	const suffix = `${suffixPrefix}${safeTitle}${suffixSuffix}`;
	const leftFillWidth = Math.max(0, width - visibleWidth(suffix));
	return borderColor(RULE.repeat(leftFillWidth) + suffix);
}

// ---------------------------------------------------------------------------
// Sticky top bar via DECSTBM scroll region
// ---------------------------------------------------------------------------
//
// How this works:
//
//   * DECSTBM (`ESC [ t ; b r`) sets the terminal's "scrolling region" to
//     rows t..b. Scroll operations (LF at bottom of region, index/reverse
//     index) only affect rows inside the region; rows outside are physically
//     pinned. We set `ESC [ 2 ; ROWS r` so row 1 is outside the scroll
//     region and therefore never moves when pi-tui emits `\r\n`s.
//
//   * Pi-tui doesn't know about our scroll region, but:
//       - It only ever writes one component at row 1: the headerContainer,
//         which we override with a 1-line blank spacer via `setHeader`.
//         So the content pi puts at row 1 is always blank.
//       - We re-paint our styled title over row 1 periodically and after
//         known render-trigger events, using save/restore cursor so pi's
//         own cursor tracking stays consistent.
//       - Terminals with synchronized output (`CSI ? 2026 h/l`) make this
//         race-free in practice: when we write between pi's `2026h/2026l`
//         brackets, the terminal buffers and atomically applies everything.
//
// Known limitations:
//   * Does NOT work inside tmux. Tmux virtualises the terminal and manages
//     its own scroll region; DECSTBM from inside a tmux pane is clipped to
//     the pane and fights with tmux's own status-bar drawing. Use the
//     `tmux` surface instead when in tmux.
//   * If pi ever switches to the alternate screen buffer or installs its
//     own DECSTBM, this will misbehave. Current pi-tui does neither.
//   * Terminals that don't implement DECSTBM correctly (very old/unusual
//     ones) will either ignore it (in which case the bar scrolls away,
//     same as `header`) or glitch. Ghostty, iTerm2, Alacritty, Kitty,
//     WezTerm, xterm, gnome-terminal, Windows Terminal all handle it.
//
// Cleanup:
//   * On `session_shutdown` we reset the scroll region and clear row 1.
//   * We also install a `process.on('exit', ...)` handler as a
//     belt-and-suspenders for abrupt exits. It emits the reset
//     synchronously via `fs.writeSync(1, ...)` since async output is
//     unreliable during process exit.

interface StickyBar {
	update(title: string, style: Style, theme: ExtensionContext["ui"]["theme"]): void;
	stop(): void;
}

function getTerminalRows(): number {
	return process.stdout.rows && process.stdout.rows > 2 ? process.stdout.rows : 24;
}

function getTerminalCols(): number {
	return process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
}

/** Raw stdout write that survives partial process teardown. */
function rawWrite(s: string): void {
	try {
		process.stdout.write(s);
	} catch {
		/* stdout may be closed during shutdown */
	}
}

/** Synchronous stdout write for `process.on('exit', ...)` handlers. */
function rawWriteSync(s: string): void {
	try {
		// `fs.writeSync(1, ...)` is the only reliable way to flush during exit.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		fs.writeSync(1, s);
	} catch {
		/* fd 1 may be closed */
	}
}

function createStickyBar(): StickyBar {
	let currentText = ""; // plain text, no escape codes
	let currentStyled = ""; // text wrapped in style escapes for painting
	let interval: ReturnType<typeof setInterval> | undefined;
	let onResize: (() => void) | undefined;
	let onExit: (() => void) | undefined;
	let installed = false;

	function setScrollRegion(): void {
		const rows = getTerminalRows();
		// Protect row 1: scroll region becomes 2..rows. All pi-tui scrolling
		// happens inside that region; row 1 is physically pinned.
		rawWrite(`\x1b[2;${rows}r`);
	}

	function resetScrollRegion(): void {
		// ESC [ r with no params restores the full scroll region.
		rawWrite("\x1b[r");
	}

	function paint(): void {
		if (!installed || currentStyled.length === 0) return;
		// Save cursor, jump to row 1 col 1, erase line, write bar, restore cursor.
		// Using DECSC/DECRC (`\x1b7`/`\x1b8`) preserves pi-tui's cursor tracking.
		// Wrap in synchronized output so the write is atomic on terminals that
		// support it (Ghostty does).
		rawWrite(`\x1b[?2026h\x1b7\x1b[1;1H\x1b[2K${currentStyled}\x1b8\x1b[?2026l`);
	}

	function install(): void {
		if (installed) return;
		installed = true;
		setScrollRegion();

		onResize = () => {
			// Terminal resize: pi-tui will do a full redraw, but we need to
			// re-assert our scroll region since some terminals reset it on
			// size change. Re-paint too.
			setScrollRegion();
			paint();
		};
		process.stdout.on("resize", onResize);

		// Periodic re-paint catches renders we don't have a direct hook for
		// (settings pane, selectors, anything that triggers pi-tui's
		// fullRender which overwrites row 1 with pi's custom header spacer).
		// 150ms is below the threshold for perceptible flicker but cheap
		// enough that it doesn't waste cycles during idle.
		interval = setInterval(paint, 150);

		// Belt-and-suspenders cleanup for abrupt exits (Ctrl+C, unhandled
		// exceptions, SIGTERM without graceful shutdown).
		onExit = () => {
			rawWriteSync("\x1b[r"); // reset scroll region
			rawWriteSync("\x1b7\x1b[1;1H\x1b[2K\x1b8"); // clear row 1
		};
		process.on("exit", onExit);
	}

	return {
		update(title, style, theme) {
			currentText = title;
			const cols = getTerminalCols();
			const label = ` π  ${title} `;
			const safe = truncateToWidth(label, cols);
			const pad = Math.max(0, cols - visibleWidth(safe));
			currentStyled = styleBarFor(safe + " ".repeat(pad), style, theme);

			if (!installed) install();
			paint();
			void currentText; // keep for debug
		},
		stop() {
			if (!installed) return;
			installed = false;
			if (interval) {
				clearInterval(interval);
				interval = undefined;
			}
			if (onResize) {
				process.stdout.off("resize", onResize);
				onResize = undefined;
			}
			if (onExit) {
				process.off("exit", onExit);
				onExit = undefined;
			}
			resetScrollRegion();
			rawWrite("\x1b7\x1b[1;1H\x1b[2K\x1b8");
			currentStyled = "";
		},
	};
}


// ---------------------------------------------------------------------------
// TitledEditor — extends CustomEditor to inlay the title into the top border
// ---------------------------------------------------------------------------
//
// Pi's editor (from @mariozechner/pi-tui) renders like:
//
//   [0]  ─────────────────────────────────     ← top border (or scroll-up indicator)
//   [1]  > your text here
//   ...
//   [N]  ─────────────────────────────────     ← bottom border (or scroll-down indicator)
//
// By subclassing CustomEditor and overriding `render`, we can swap line 0
// with our title-inlaid divider. Pi's `setCustomEditorComponent` uses duck
// typing (`"actionHandlers" in newEditor`) to wire app-level handlers, which
// works transparently for any CustomEditor subclass loaded via jiti. Editor
// text and other state are preserved across editor swaps by pi.
//
// We use a shared mutable state object instead of passing title/style/theme
// to the constructor, so `/title` updates reflect without having to rebuild
// the editor. `theme` is the pi theme singleton (a globalThis Proxy), so a
// captured reference automatically tracks theme changes.

interface TitleState {
	title: string;
}

class TitledEditor extends CustomEditor {
	private readonly _titleState: TitleState;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		state: TitleState,
	) {
		super(tui, editorTheme, keybindings);
		this._titleState = state;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		const { title } = this._titleState;
		if (!title) return lines;

		// Preserve scroll-up indicator (`─── ↑ N more ────`). When the user has
		// scrolled the editor viewport, that indicator is more informative
		// than our title; keep it.
		if (lines[0].includes("\u2191")) return lines;

		lines[0] = renderDivider(title, width, this.borderColor);
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("title", {
		description: `Title to pin somewhere visible in pi (overrides $${ENV_TITLE}).`,
		type: "string",
	});
	pi.registerFlag("title-style", {
		description: `Header bar style. One of: ${ALLOWED_STYLES.join(", ")}. Default: ${DEFAULT_STYLE}.`,
		type: "string",
	});
	pi.registerFlag("title-position", {
		description: `Comma-separated list of surfaces: ${ALLOWED_SURFACES.join(",")}. Default depends on env (terminal,footer [+tmux if $TMUX]).`,
		type: "string",
	});
	pi.registerFlag("no-auto-title", {
		description: `Disable LLM-generated session title. Also disabled by $${ENV_AUTO_TITLE}=0.`,
		type: "boolean",
		default: false,
	});

	// Runtime overrides (in-memory, cleared on restart).
	let titleOverride: string | undefined;
	let styleOverride: Style | undefined;
	let positionOverride: Surface[] | undefined;

	// Auto-title: populated asynchronously after the threshold fires.
	// Never beats `/title`, `--title`, or `$PI_SESSION_TITLE`; only sits
	// above the git-branch / cwd fallbacks.
	let autoTitle: string | undefined;
	const autoTitleState: AutoTitleState = {
		status: "idle",
		userChars: 0,
		sawToolCall: false,
	};

	// Shared state the `TitledEditor` reads on every render. Mutating these
	// fields plus requesting a re-render is enough to update the divider
	// without rebuilding the editor (which would churn cursor state).
	const titleState: TitleState = { title: "" };
	let titledEditorInstalled = false;
	let editorTui: TUI | undefined;

	function requestEditorRerender(): void {
		editorTui?.requestRender();
	}


	function hasExplicitTitle(): boolean {
		if (titleOverride && titleOverride.length > 0) return true;
		const fromFlag = pi.getFlag("title");
		if (typeof fromFlag === "string" && fromFlag.length > 0) return true;
		const fromEnv = process.env[ENV_TITLE];
		if (fromEnv && fromEnv.length > 0) return true;
		return false;
	}

	function isAutoTitleDisabled(): boolean {
		// Flag is `no-auto-title` (pi convention), so `true` means disabled.
		const flag = pi.getFlag("no-auto-title");
		if (typeof flag === "boolean" && flag) return true;
		const env = process.env[ENV_AUTO_TITLE]?.trim();
		if (env && /^(0|off|false|no)$/i.test(env)) return true;
		return false;
	}

	function resolveTitle(): string {
		if (titleOverride && titleOverride.length > 0) return titleOverride;
		const fromFlag = pi.getFlag("title");
		if (typeof fromFlag === "string" && fromFlag.length > 0) return fromFlag;
		const fromEnv = process.env[ENV_TITLE];
		if (fromEnv && fromEnv.length > 0) return fromEnv;
		if (autoTitle && autoTitle.length > 0) return autoTitle;
		const branch = getGitBranch();
		if (branch && branch.length > 0) return branch;
		return path.basename(process.cwd());
	}

	function resolveStyle(): Style {
		if (styleOverride) return styleOverride;
		const fromFlag = pi.getFlag("title-style");
		if (typeof fromFlag === "string" && isStyle(fromFlag)) return fromFlag;
		const fromEnv = process.env[ENV_STYLE];
		if (fromEnv && isStyle(fromEnv)) return fromEnv;
		return DEFAULT_STYLE;
	}

	function resolvePosition(): Surface[] {
		if (positionOverride) return positionOverride;
		const fromFlag = parsePosition(pi.getFlag("title-position") as string | undefined);
		if (fromFlag) return fromFlag;
		const fromEnv = parsePosition(process.env[ENV_POSITION]);
		if (fromEnv) return fromEnv;
		return defaultPosition();
	}

	// Compose fg+bg cleanly: pi's theme.fg resets with \x1b[39m, theme.bg
	// with \x1b[49m, and inverse uses \x1b[7m/\x1b[27m. They nest correctly.
	const styleBar = styleBarFor;

	// Lazy-initialized sticky bar. Created on first use, torn down on
	// session_shutdown or when `sticky` leaves the active surface set.
	let stickyBar: StickyBar | undefined;

	function tearDownSticky(): void {
		if (stickyBar) {
			stickyBar.stop();
			stickyBar = undefined;
		}
	}


	function applyTitle(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		const title = resolveTitle();
		const style = resolveStyle();
		const surfaces = new Set(resolvePosition());

		// ---- OS terminal window/tab title (always-sticky) ----
		if (surfaces.has("terminal")) {
			ctx.ui.setTitle(`π ${title}`);
		}

		// ---- tmux window name (sticky in tmux status bar) ----
		if (surfaces.has("tmux")) {
			updateTmuxWindowName(`π ${title}`);
		}

		// ---- pi footer status line (sticky to viewport bottom) ----
		if (surfaces.has("footer")) {
			const theme = ctx.ui.theme;
			ctx.ui.setStatus(STATUS_KEY, theme.bold(theme.fg("accent", `π ${title}`)));
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		// ---- Claude-style divider inlaid into the editor's top border ------
		// (sticky because the editor is anchored to the viewport bottom)
		if (surfaces.has("divider")) {
			titleState.title = title;

			if (!titledEditorInstalled) {
				ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
					editorTui = tui;
					return new TitledEditor(tui, editorTheme, keybindings, titleState);
				});
				titledEditorInstalled = true;
			} else {
				requestEditorRerender();
			}
		} else if (titledEditorInstalled) {
			ctx.ui.setEditorComponent(undefined);
			titledEditorInstalled = false;
			editorTui = undefined;
		}

		// ---- pi header bar (NOT sticky; cosmetic) ----
		if (surfaces.has("header")) {
			ctx.ui.setHeader((_tui, theme) => ({
				render(width: number): string[] {
					if (width <= 0) return [""];
					const label = ` π  ${title} `;
					const safe = truncateToWidth(label, width);
					const pad = Math.max(0, width - visibleWidth(safe));
					return [styleBar(safe + " ".repeat(pad), style, theme)];
				},
				invalidate() {},
			}));
		} else if (surfaces.has("sticky")) {
			// Sticky mode reserves row 1 for itself and needs pi to render a
			// 1-line blank at the top of its frame so pi doesn't fight us for
			// row 1. We install a no-op header for this.
			ctx.ui.setHeader((_tui, _theme) => ({
				render(_width: number): string[] {
					return [""];
				},
				invalidate() {},
			}));
		} else {
			ctx.ui.setHeader(undefined);
		}

		// ---- sticky top bar via DECSTBM (experimental, terminal-dependent) --
		if (surfaces.has("sticky")) {
			if (process.env.TMUX) {
				// DECSTBM inside tmux is clipped to the pane and fights with
				// tmux's own rendering. Refuse and nudge user toward the `tmux`
				// surface, which gives them a real sticky status bar.
				ctx.ui.notify(
					"sticky: disabled inside tmux (use `tmux` surface instead — it renames the tmux window and shows up in your status bar).",
					"warning",
				);
				tearDownSticky();
			} else {
				if (!stickyBar) stickyBar = createStickyBar();
				stickyBar.update(title, style, ctx.ui.theme);
			}
		} else {
			tearDownSticky();
		}
	}

	// ---- auto-title: pick a cheap model with resolved auth --------------
	async function pickAutoTitleModel(
		ctx: ExtensionContext,
	): Promise<{ model: Model<Api>; apiKey: string; headers?: Record<string, string> } | undefined> {
		const explicit = parseModelList(process.env[ENV_AUTO_TITLE_MODEL]);
		const listEnv = parseModelList(process.env[ENV_AUTO_TITLE_MODELS]);
		const candidates: ReadonlyArray<readonly [string, string]> =
			explicit ?? listEnv ?? DEFAULT_AUTO_TITLE_MODELS;

		for (const [provider, id] of candidates) {
			const model = ctx.modelRegistry.find(provider, id);
			if (!model) continue;
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey) continue;
				return { model, apiKey: auth.apiKey, headers: auth.headers };
			} catch {
				/* try next candidate */
			}
		}

		// Last resort: the model the user is already using. This can be
		// expensive per call but at least we know auth works, and with
		// maxTokens=40 the cost is negligible.
		if (ctx.model) {
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (auth.ok && auth.apiKey) return { model: ctx.model, apiKey: auth.apiKey, headers: auth.headers };
			} catch {
				/* fall through to skipped */
			}
		}
		return undefined;
	}

	async function generateAutoTitle(ctx: ExtensionContext): Promise<void> {
		autoTitleState.status = "pending";
		try {
			const picked = await pickAutoTitleModel(ctx);
			if (!picked) {
				autoTitleState.status = "skipped";
				return;
			}
			const response = await completeSimple(
				picked.model,
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: buildAutoTitlePrompt(autoTitleState.firstPrompt, autoTitleState.sawToolCall),
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: picked.apiKey,
					headers: picked.headers,
					maxTokens: AUTO_TITLE_MAX_TOKENS,
					// Reasoning models would happily burn thousands of tokens to
					// think about a 3-word title. Titles don't need thinking.
					// `pi-ai`'s SimpleStreamOptions ThinkingLevel doesn't include
					// "off"; "minimal" is the cheapest portable choice.
					reasoning: "minimal",
					signal: ctx.signal,
				},
			);
			const raw = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const sanitized = sanitizeAutoTitle(raw);
			if (!sanitized) {
				autoTitleState.status = "skipped";
				return;
			}
			// If the user set an explicit title while we were in-flight, defer
			// to them: still record the result for a later `/title` clear, but
			// don't repaint now — their title wins via resolveTitle().
			autoTitle = sanitized;
			autoTitleState.status = "done";
			autoTitleState.result = sanitized;
			applyTitle(ctx);
		} catch {
			// Silent: auto-title is quality-of-life. Next session may pick a
			// different model / have credentials / etc.
			autoTitleState.status = "skipped";
		}
	}

	function maybeTriggerAutoTitle(ctx: ExtensionContext): void {
		if (autoTitleState.status !== "idle") return;
		// Non-interactive modes don't show titles at all (see applyTitle),
		// so there's no point burning tokens for them.
		if (!ctx.hasUI) {
			autoTitleState.status = "disabled";
			return;
		}
		if (isAutoTitleDisabled()) {
			autoTitleState.status = "disabled";
			return;
		}
		if (hasExplicitTitle()) {
			// User provided one — we're done here. Note this is a per-session
			// decision; if they later `/title` to clear, auto-title stays
			// disabled until they explicitly `/retitle`.
			autoTitleState.status = "disabled";
			return;
		}
		const threshold = parseAutoTitleThreshold();
		if (!autoTitleState.sawToolCall && autoTitleState.userChars < threshold) return;
		void generateAutoTitle(ctx);
	}

	/** Seed userChars / sawToolCall / firstPrompt from replayed session history. */
	function seedAutoTitleFromHistory(ctx: ExtensionContext): void {
		if (autoTitleState.status !== "idle") return;
		let branch: ReturnType<typeof ctx.sessionManager.getBranch>;
		try {
			branch = ctx.sessionManager.getBranch();
		} catch {
			return;
		}
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg || typeof msg !== "object" || !("role" in msg)) continue;
			if (msg.role === "user") {
				autoTitleState.userChars += estimateTextLength(msg.content);
				if (!autoTitleState.firstPrompt) {
					const text = extractFirstText(msg.content);
					if (text) autoTitleState.firstPrompt = text;
				}
			} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part && typeof part === "object" && (part as { type?: string }).type === "toolCall") {
						autoTitleState.sawToolCall = true;
						break;
					}
				}
			}
		}
	}

	pi.on("session_start", async (event, ctx) => {
		applyTitle(ctx);
		// On resume/fork the branch already has history; seed from it so the
		// threshold fires on the next turn instead of requiring fresh
		// activity. On "startup" / "new" / "reload" the branch is empty
		// (or we reset on shutdown) and this is a no-op.
		if (event.reason === "resume" || event.reason === "fork") {
			seedAutoTitleFromHistory(ctx);
			maybeTriggerAutoTitle(ctx);
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!autoTitleState.firstPrompt && event.prompt && event.prompt.length > 0) {
			autoTitleState.firstPrompt = event.prompt;
		}
	});

	pi.on("message_end", async (event) => {
		if (autoTitleState.status !== "idle") return;
		const msg = event.message;
		if (!msg || typeof msg !== "object" || !("role" in msg)) return;
		if (msg.role !== "user") return;
		autoTitleState.userChars += estimateTextLength(msg.content);
	});

	pi.on("tool_execution_start", async () => {
		if (autoTitleState.status !== "idle") return;
		autoTitleState.sawToolCall = true;
	});

	pi.on("turn_end", async (_event, ctx) => {
		maybeTriggerAutoTitle(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Restore terminal state before pi tears everything down.
		tearDownSticky();
		if (titledEditorInstalled && ctx?.hasUI) {
			ctx.ui.setEditorComponent(undefined);
			titledEditorInstalled = false;
			editorTui = undefined;
		}
		// Reset auto-title state so a `reload` (which keeps the same
		// extension runtime per session_shutdown docs) starts fresh.
		autoTitle = undefined;
		resetAutoTitleState(autoTitleState);
		cachedGitBranch = undefined;
	});

	// ---- runtime commands -------------------------------------------------

	pi.registerCommand("title", {
		description: "Set or clear the session title",
		handler: async (args, ctx) => {
			const next = (args ?? "").trim();
			titleOverride = next.length > 0 ? next : undefined;
			applyTitle(ctx);
			ctx.ui.notify(
				titleOverride ? `Title set to "${titleOverride}"` : `Title cleared (now "${resolveTitle()}")`,
				"info",
			);
		},
	});

	pi.registerCommand("title-style", {
		description: `Set or clear the header bar style (${ALLOWED_STYLES.join(", ")})`,
		getArgumentCompletions: (prefix) => {
			const items = ALLOWED_STYLES.map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const next = (args ?? "").trim();
			if (next.length === 0) {
				styleOverride = undefined;
				applyTitle(ctx);
				ctx.ui.notify(`Style cleared (now "${resolveStyle()}")`, "info");
				return;
			}
			if (!isStyle(next)) {
				ctx.ui.notify(`Unknown style "${next}". Allowed: ${ALLOWED_STYLES.join(", ")}`, "error");
				return;
			}
			styleOverride = next;
			applyTitle(ctx);
			ctx.ui.notify(`Style set to "${styleOverride}"`, "info");
		},
	});

	pi.registerCommand("retitle", {
		description: "Regenerate the auto-title via LLM (ignores the once-per-session guard)",
		handler: async (_args, ctx) => {
			if (isAutoTitleDisabled()) {
				ctx.ui.notify(
					`Auto-title is disabled (via --no-auto-title or $${ENV_AUTO_TITLE}). Enable it to use /retitle.`,
					"warning",
				);
				return;
			}
			if (hasExplicitTitle()) {
				ctx.ui.notify(
					"An explicit title is set (via /title, --title, or $PI_SESSION_TITLE). Clear it first to use /retitle.",
					"warning",
				);
				return;
			}
			// Clear the previous result and reset the state machine so the
			// dispatcher can fire again. Keep firstPrompt / userChars / sawToolCall
			// so we have context to work with — those are the inputs, not the
			// output.
			autoTitle = undefined;
			autoTitleState.status = "idle";
			autoTitleState.result = undefined;
			ctx.ui.notify("Regenerating title...", "info");
			await generateAutoTitle(ctx);
			// Widen through a cast: TS narrows `autoTitleState.status` based
			// on the assignments above, but `generateAutoTitle` mutates it
			// asynchronously to "done" or "skipped".
			const finalStatus = autoTitleState.status as AutoTitleStatus;
			if (finalStatus === "done" && autoTitleState.result) {
				ctx.ui.notify(`Title set to "${autoTitleState.result}"`, "info");
			} else {
				ctx.ui.notify(
					"Could not generate a title (no suitable model / auth / valid response). Falling back.",
					"warning",
				);
			}
		},
	});

	pi.registerCommand("title-position", {
		description: `Set or clear where the title renders (comma-separated: ${ALLOWED_SURFACES.join(", ")})`,
		getArgumentCompletions: (prefix) => {
			// Suggest individual surface names. Comma-separated lists are
			// typed manually; this just helps with the first token.
			const items = ALLOWED_SURFACES.map((p) => ({ value: p, label: p }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (raw.length === 0) {
				positionOverride = undefined;
				applyTitle(ctx);
				ctx.ui.notify(`Position cleared (now ${resolvePosition().join(",")})`, "info");
				return;
			}
			const parsed = parsePosition(raw);
			if (!parsed) {
				ctx.ui.notify(
					`Invalid position "${raw}". Use comma-separated values from: ${ALLOWED_SURFACES.join(", ")}`,
					"error",
				);
				return;
			}
			positionOverride = parsed;
			applyTitle(ctx);
			ctx.ui.notify(`Position set to ${positionOverride.join(",")}`, "info");
		},
	});
}
