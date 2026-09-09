#!/usr/bin/env python3
"""Real-terminal acceptance smoke tests for jpn, using only the Python stdlib."""

from __future__ import annotations

import errno
import os
import re
import signal
import sys
import time

try:
    import fcntl
    import pty
    import select
    import struct
    import termios
except (ImportError, AttributeError) as error:
    print(f"SKIP PTY smoke: stdlib PTY support unavailable ({error})")
    raise SystemExit(0)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "src", "index.ts")
ALT_ENTER = b"\x1b[?1049h"
ALT_EXIT = b"\x1b[?1049l"
OSC52_NIHONGO = b"\x1b]52;c;5pel5pys6Kqe\x07"
TIMEOUT = 10.0


def set_size(fd: int, width: int, height: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))


def write_key(fd: int, value: bytes) -> None:
    os.write(fd, value)


def run_case(name: str, actions: list[tuple[float, str, object]]) -> tuple[bytes, int]:
    """Run one isolated app, staging actions by elapsed time and always reaping it."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        environment = os.environ.copy()
        environment.update({"TERM": "xterm-256color", "COLORTERM": "truecolor"})
        os.execve(APP, [APP], environment)

    output = bytearray()
    status: int | None = None
    started = time.monotonic()
    pending = list(actions)
    try:
        set_size(fd, 80, 24)
        while time.monotonic() - started < TIMEOUT:
            elapsed = time.monotonic() - started
            while pending and elapsed >= pending[0][0]:
                _, kind, payload = pending.pop(0)
                if kind == "write":
                    write_key(fd, payload)  # type: ignore[arg-type]
                elif kind == "resize":
                    width, height = payload  # type: ignore[misc]
                    set_size(fd, width, height)
                    os.kill(pid, signal.SIGWINCH)
                else:
                    raise AssertionError(f"unknown PTY action {kind}")

            ready, _, _ = select.select([fd], [], [], 0.03)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                    if chunk:
                        output.extend(chunk)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise

            waited, child_status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                status = os.waitstatus_to_exitcode(child_status)
                break

        if status is None:
            raise AssertionError(f"{name} exceeded hard timeout of {TIMEOUT}s")

        # Drain bytes buffered immediately before process exit.
        for _ in range(10):
            ready, _, _ = select.select([fd], [], [], 0.01)
            if not ready:
                break
            try:
                output.extend(os.read(fd, 65536))
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
        return bytes(output), status
    finally:
        if status is None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
        os.close(fd)


def after_final_exit(output: bytes) -> bytes:
    position = output.rfind(ALT_EXIT)
    assert position >= 0, "alternate screen was not restored"
    suffix = output[position + len(ALT_EXIT) :]
    # Renderer shutdown still resets terminal modes after leaving the alternate
    # screen. Those controls are not ordinary output visible to the caller.
    suffix = re.sub(rb"\x1b\][^\x07]*(?:\x07|\x1b\\)", b"", suffix)
    suffix = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", suffix)
    return suffix


def main() -> None:
    if os.name != "posix" or not hasattr(pty, "fork"):
        print("SKIP PTY smoke: requires POSIX pty.fork")
        return
    if not os.path.isfile(APP) or not os.access(APP, os.X_OK):
        raise AssertionError(f"source checkout executable is missing or not executable: {APP}")

    # Delays are intentional: exercise real key decoding/rendering rather than
    # relying on a single coalesced write that can race terminal startup.
    enter, enter_code = run_case(
        "enter",
        [
            (0.8, "write", b"i"),
            (1.0, "write", b"nihongo"),
            (1.25, "write", b"\x1b"),
            (1.5, "write", b"3"),
            (1.7, "write", b"\r"),
        ],
    )
    assert enter_code == 0, f"Enter exited {enter_code}"
    assert ALT_ENTER in enter, "Enter case never entered alternate screen"
    visible_cursor_positions = re.findall(
        rb"\x1b\[(\d+);(\d+)H\x1b\[\?25h", enter
    )
    assert visible_cursor_positions, "Enter case emitted no visible cursor position"
    assert visible_cursor_positions[-1][0] == b"4", (
        "final input cursor must be positioned on terminal row 4, not row 3"
    )
    assert after_final_exit(enter) in ("日本語\n".encode(), "日本語\r\n".encode()), (
        "only the submitted value may follow final alternate-screen exit"
    )

    quit_output, quit_code = run_case("quit", [(0.8, "write", b"q")])
    assert quit_code == 0, f"q exited {quit_code}"
    assert ALT_ENTER in quit_output
    assert after_final_exit(quit_output) == b"", "q emitted ordinary trailing output"

    interrupt, interrupt_code = run_case(
        "ctrl-c", [(0.8, "write", b"\x03")]
    )
    assert interrupt_code == 130, f"Ctrl-C exited {interrupt_code}, expected 130"
    assert ALT_ENTER in interrupt
    assert after_final_exit(interrupt) == b"", "Ctrl-C emitted trailing output"

    yank, yank_code = run_case(
        "yank",
        [
            (0.8, "write", b"i"),
            (1.0, "write", b"nihongo"),
            (1.25, "write", b"\x1b"),
            (1.5, "write", b"3"),
            (1.7, "write", b"y"),
            (2.0, "write", b"q"),
        ],
    )
    assert yank_code == 0, f"yank case exited {yank_code}"
    assert OSC52_NIHONGO in yank, "capture omitted exact OSC 52 bytes"
    assert b"Clipboard sequence sent" in yank

    resized, resize_code = run_case(
        "resize",
        [
            (0.8, "resize", (59, 14)),
            (1.2, "resize", (80, 24)),
            (1.6, "write", b"q"),
        ],
    )
    assert resize_code == 0, f"resize case exited {resize_code}"
    assert b"Terminal too small (59x14)" in resized, "minimum-size text not rendered"
    small_at = resized.index(b"Terminal too small (59x14)")
    assert b"Japanese composer" in resized[small_at:], "normal view did not return after resize"

    print("PTY smoke passed: Enter, q, Ctrl-C, OSC52, and resize")


if __name__ == "__main__":
    main()
