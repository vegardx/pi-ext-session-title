# pi-ext-session-title

A [pi.dev](https://shittycodingagent.ai) extension that pins a
user-configurable title in places that stay visible while pi is running, so
you can tell different pi instances apart at a glance.

## How it shows up

The default setup inlays the title into **pi's existing input-box top
border** (Claude-Code style):

```
(conversation …)

────────────────────────────────────────────────────────── prod-api ───
> _
───────────────────────────────────────────────────────────────────
  anthropic/claude-sonnet-4-5    ↑ 1.2k ↓ 340 $0.01  main
```

That top border **already exists** in pi's editor (rendered by pi-tui's
`Editor` component). We replace it with a title-inlaid, right-aligned
variant instead of adding a new line above it — so there's no duplicated
horizontal rule and no extra vertical space used.

Technically: the extension uses `ctx.ui.setEditorComponent(...)` to swap
pi's default `CustomEditor` for a subclass that overrides `render()` and
patches line 0 of the output. Pi's built-in duck-typed handler copying
(`setCustomEditorComponent` wires up escape / Ctrl-D / paste / action
handlers onto any CustomEditor subclass), so every keybinding still works.

The OS terminal window/tab title is also set to `π prod-api`.

## Why this is harder than a header

Pi's TUI uses **inline differential rendering**. It does *not* use the
alternate screen buffer and does *not* set a DECSTBM scroll region — it
writes its frame directly to your terminal's normal scrollback area.
That means a top-of-frame header (`ctx.ui.setHeader()`) scrolls up into
scrollback as the conversation grows — "scrolling text pushes it up",
which is what you'll see if you try the `header` surface.

The sticky-to-the-viewport zone in pi is the **bottom** of the frame
(editor + footer), because pi positions its hardware cursor there every
render. So the Claude trick — anchoring the title to the top of the
input area — is exactly what you want. This extension implements it via
`ctx.ui.setWidget(..., { placement: "aboveEditor" })`.

## Surfaces

Five surfaces, combinable via `--title-position`:

| Surface    | Sticky where?                                 | How                                      |
| ---------- | --------------------------------------------- | ---------------------------------------- |
| `terminal` | Top of the terminal **window** chrome         | OS `ESC]0;…` (title bar / tab label)     |
| `divider`  | **Inlaid into the input box's top border**    | `ctx.ui.setEditorComponent(...)` subclasses `CustomEditor` and patches line 0 of `render()` using the editor's existing border color |
| `tmux`     | Tmux status bar (top or bottom, your cfg)     | `tmux rename-window`, referenced as `#W` |
| `footer`   | Bottom of pi's viewport, inside the footer    | `ctx.ui.setStatus(...)` — composes with pi's default footer |
| `header`   | **Not sticky** — scrolls with content         | `ctx.ui.setHeader(...)` — cosmetic only  |
| `sticky`   | Terminal row 1, pinned via scroll region      | DECSTBM hack (see below). Doesn't work in tmux. |

Default is `terminal,divider` (plus `tmux` if `$TMUX` is set). This gives
you the sticky divider inside pi plus the OS window title outside pi —
both always-visible, no hacks.

### The `sticky` surface (advanced / optional)

If you want a bar pinned literally to row 1 of the terminal (so text
scrolls beneath it instead of beside it), modern VT-compliant terminals
(Ghostty, iTerm2, Alacritty, Kitty, WezTerm, xterm, Windows Terminal)
support DECSTBM scroll regions, and the extension can exploit that with
some raw-ANSI juggling.

When `sticky` is enabled, the extension:

1. Emits `ESC [ 2 ; ROWS r` to carve row 1 out of the scroll region.
2. Overrides pi's header with a 1-line blank so pi doesn't write real
   content at row 1.
3. Paints your styled title at row 1 and re-paints every 150ms (and on
   resize), using save-cursor / restore-cursor so pi's own cursor
   tracking stays correct.
4. Wraps writes in synchronized output (`CSI ? 2026`) so paints are
   atomic where supported.
5. Restores the scroll region and clears row 1 on session shutdown and
   on abrupt process exit.

**Known limitations:** does not work inside tmux (tmux owns the scroll
region and clips DECSTBM to the pane — it fights with tmux's own status
drawing). The extension detects `$TMUX` and refuses `sticky` with a
notification pointing you at the `tmux` surface instead.

For most users, **`divider` is the better answer than `sticky`** — it
uses pi's supported widget API, works in every terminal, and doesn't
fight pi's renderer.

## Install

```bash
# global (available in every pi session)
pi install git:github.com/vegardx/pi-ext-session-title

# project-local (stored in .pi/settings.json, shareable with your team)
pi install -l git:github.com/vegardx/pi-ext-session-title
```

Try without installing:

```bash
pi -e /path/to/pi-ext-session-title/src/index.ts --title "demo"
```

## Setting the title

Priority (highest first):

1. `/title <name>` command inside pi.
2. `--title "<name>"` CLI flag.
3. `PI_SESSION_TITLE` env var.
4. Current git branch, if inside a repo.
5. Fallback: basename of `cwd`.

```bash
pi --title "Prod API"
PI_SESSION_TITLE="Prod API" pi
```

Inside pi: `/title Prod API`, or `/title` to clear the override.

## Choosing surfaces (`--title-position`)

Accepts a **comma-separated list** of any of: `terminal`, `divider`,
`footer`, `tmux`, `sticky`, `header`.

Priority: `/title-position` → `--title-position` flag →
`PI_SESSION_TITLE_POSITION` env → default (`terminal,divider` plus
`tmux` if `$TMUX` is set).

```bash
# Default: Claude-style divider above input, plus OS tab title
pi --title "Prod API"

# Add tmux status bar integration (automatic if $TMUX is set)
pi --title "Prod API" --title-position terminal,divider,tmux

# Also show a line in the footer
pi --title "Prod API" --title-position terminal,divider,footer

# Experimental: pin literally to row 1 of the terminal (not in tmux)
pi --title "Prod API" --title-position terminal,divider,sticky

# Minimal: only the OS tab title
pi --title "api-$(whoami)" --title-position terminal

# Cosmetic header bar at top (will scroll off — use only for short sessions)
pi --title "demo" --title-position terminal,header
```

Inside pi:

```
/title-position terminal,divider
/title-position terminal,divider,tmux
/title-position                          # clear, revert to smart default
```

### tmux integration

If `$TMUX` is set (or you include `tmux` explicitly in `--title-position`),
the extension runs `tmux rename-window "π <title>"` whenever the title is
applied. The name shows up in any tmux status template that references
`#W`. Nothing to configure in tmux if you use a default config:

```bash
# ~/.tmux.conf — a minimal sticky status bar at the top:
set -g status-position top
set -g status-left  ' #W '
set -g status-right '%H:%M '
```

Tmux status bars are honest sticky — they're drawn outside pi's scroll area.

### Which position should I use?

- **Just use the default** (`terminal,divider`) — you get a sticky
  Claude-style divider right above your input field, plus the OS
  terminal tab title. Works in every terminal, no hacks. This is the
  answer for ~95% of use cases.

- **Inside tmux** — default auto-adds `tmux`, so the title also shows
  up wherever your tmux status bar has `#W`. If you want a big sticky
  top bar, put `status-position top` in your tmux config.

- **Want a bar literally pinned to row 1 of your Ghostty window** — add
  `sticky`: `--title-position terminal,divider,sticky`. Experimental;
  uses DECSTBM + raw ANSI. Doesn't work in tmux.

- **Add a footer line too** — add `footer`:
  `--title-position terminal,divider,footer`. Shows in pi's footer
  alongside branch, token stats, etc.

## Style (`--title-style`)

Affects the `header` and `sticky` surfaces.

`divider` intentionally ignores the extra styling knobs and uses the
editor's **existing border color**, so it matches the rest of the input
box exactly.

Priority: `/title-style` → `--title-style` → `PI_SESSION_TITLE_STYLE` env
→ default `inverse`.

| Value                     | Looks like                                                   |
| ------------------------- | ------------------------------------------------------------ |
| `inverse` *(default)*     | Swaps terminal fg/bg. **Guaranteed visible** in any theme.   |
| `plain`                   | No background, accent-colored bold text.                     |
| `bg-customMessageBg`      | Subtle themed bg (same palette as custom-message messages).  |
| `bg-userMessageBg`        | Subtle themed bg (same palette as user messages).            |
| `bg-selectedBg`           | Subtle themed bg (same palette as selections).               |
| `bg-toolPendingBg`        | Subtle dark-blue themed bg.                                  |
| `bg-toolSuccessBg`        | Subtle dark-green themed bg.                                 |
| `bg-toolErrorBg`          | Subtle dark-red themed bg.                                   |

> Pi's theme bg tokens are intentionally subtle (e.g. `#2d2838` on a dark
> terminal is nearly indistinguishable from the terminal background). They
> exist for low-noise message highlighting, not title bars. `inverse`
> guarantees the bar is visible regardless of theme.

## Environment variables summary

```bash
export PI_SESSION_TITLE="prod-api"
export PI_SESSION_TITLE_STYLE="inverse"
export PI_SESSION_TITLE_POSITION="terminal,footer,tmux"
```

## Development

```bash
npx tsc --noEmit                              # type-check
pi -e ./src/index.ts --title "dev"            # run against local source
```

Entry point: [`src/index.ts`](./src/index.ts).

## License

MIT
