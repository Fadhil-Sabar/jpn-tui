# jpn-tui

A small Vim-style terminal composer that turns romaji or kana into live hiragana, katakana, and best-effort kanji previews.

## Requirements and installation

- [Bun](https://bun.sh/) (the runtime and package manager)
- A terminal at least **60 columns × 15 rows**

From a source checkout:

```sh
bun install
bun run src/index.ts
```

To install the `jpn` command from that checkout:

```sh
bun link
jpn
```

`jpn` starts in Normal mode. Press `i` to enter text.

## Keys

`Enter` and `Ctrl-C` work in both modes: `Enter` accepts the selected preview; `Ctrl-C` exits with status 130.

### Normal mode

| Key | Action |
| --- | --- |
| `h`, `l` | Move left or right |
| `0`, `$` | Move to the start or end |
| `w`, `b`, `e` | Move by word (`e` moves to the end) |
| `i`, `a` | Insert before or after the cursor |
| `I`, `A` | Insert at the start or end |
| `x` | Delete the grapheme under the cursor |
| `D` | Delete from the cursor to the end |
| `dd` | Delete the whole input |
| `u`, `Ctrl-R` | Undo or redo |
| `j`, `k` | Select the next or previous preview |
| `Tab`, `Shift-Tab` | Cycle previews forward or backward |
| `1`, `2`, `3` | Select hiragana, katakana, or kanji |
| `y` | Copy the selected preview (native clipboard first, OSC 52 fallback) |
| `s` | Open Settings |
| `q` | Quit without output |

### Insert mode

| Key | Action |
| --- | --- |
| Printable Unicode / paste | Insert text (pasted CR/LF characters are removed) |
| `Esc` | Return to Normal mode |
| `Backspace`, `Delete` | Delete before or at the caret |
| `Left`, `Right`, `Home`, `End` | Move the caret |
| `Ctrl-W` | Delete the previous word |
| `Ctrl-U` | Delete to the start |

Settings uses `j`/`k`, arrows, `Tab`, or `1`/`2`/`3` to move between rows. Select **AI Prediction** and then choose a Prediction Engine. The active engine is shown with `●`; the focused row is independent of the active engine.

## Previews and output

The three rows update while editing:

1. **ひらがな** converts complete romaji words and normalizes kana.
2. **カタカナ** renders that reading in katakana.
3. **漢字** uses the bundled JMdict-derived dictionary to choose a best-effort spelling.

Examples:

| Input | Hiragana | Katakana | Kanji |
| --- | --- | --- | --- |
| `nihongo` | `にほんご` | `ニホンゴ` | `日本語` |
| `watashi wa gakusei desu` | `わたしわがくせいです` | `ワタシワガクセイデス` | `私は学生です` |
| `arigatou gozaimasu` | `ありがとうございます` | `アリガトウゴザイマス` | `ありがとうございます` |

`Enter` restores the terminal and writes only the selected value plus a newline to standard output, so it can be captured or redirected. `y` copies without exiting. It first tries the platform clipboard command: `wl-copy` on Linux Wayland, `xclip` then `xsel` on Linux X11 (including XFCE), `pbcopy` on macOS, or `clip.exe` on Windows and WSL. These commands are optional and no shell is involved.

If no applicable native command succeeds, `jpn` sends the existing OSC 52 sequence for SSH, minimal systems, and compatible terminals. The status line identifies a successful native backend; the OSC 52 fallback is explicitly unconfirmed because terminal and multiplexer policy can reject it.

Kanji conversion is dictionary-ranked segmentation, not Mozc or a contextual IME. Readings with multiple valid spellings can therefore produce an unintended result; select a kana row when exactness matters.

## Optional local Jinen prediction

Jinen is an optional local prediction backend for the Kanji row. The available GGUF models are:

- **Jinen xsmall** (~28 MB, **Recommended**), Q5_K_M
- **Jinen small** (~81 MB, higher-quality), Q5_K_M

Models are not bundled. Jinen runs through node-llama-cpp/llama.cpp, CPU-only, deterministically and locally. The bundled dictionary is the default and deterministic fallback: it works offline, and a Jinen load, inference, or invalid-output failure leaves the exact dictionary result in place.

Jinen models are used only after they have been explicitly enabled in Settings. If a selected model is not installed, Settings shows its size and asks for confirmation. Choose **Download** to begin; choosing **Cancel** or leaving the prompt does not download anything. Network access for a model occurs only after that explicit confirmation. After download, the model is stored under `$XDG_DATA_HOME/jpn-tui/models`; when `XDG_DATA_HOME` is unset, the default is `~/.local/share/jpn-tui/models`.

## Offline use and dictionary rebuild

Dictionary-only operation is offline: `data/jmdict.sqlite` is bundled and no runtime network request is made. Optional Jinen inference is local after its model is installed; the only Jinen network access is the explicitly confirmed model download. Dependency installation may require network access. A dictionary rebuild first uses the verified `.cache/jmdict/jmdict.tgz` archive when available and otherwise downloads the pinned release; it always verifies the source SHA-256. The rebuild also requires `tar`:

```sh
bun run data:build
```

Dictionary provenance and licensing are documented in [`data/README.md`](data/README.md).

## Checks

```sh
bun test
bun run test:pty
bun run typecheck
bun run lint
bun run build
bun run smoke
```

The PTY test requires POSIX Python 3 PTY support. Application code is MIT licensed; the derived dictionary data has separate CC BY-SA 4.0 terms.
