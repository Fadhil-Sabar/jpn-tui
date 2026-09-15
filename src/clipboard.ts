import { spawn } from "node:child_process";
import { release as osRelease } from "node:os";

export type ClipboardBackend =
  | "wl-copy"
  | "xclip"
  | "xsel"
  | "pbcopy"
  | "clip.exe";

export interface NativeClipboardResult {
  readonly backend: ClipboardBackend;
}

export type ClipboardCopy = (
  value: string,
  signal?: AbortSignal,
) => Promise<NativeClipboardResult | null>;

export interface ClipboardSpawnOptions {
  readonly input: string;
  readonly shell: false;
  readonly stdio: ["pipe", "ignore", "ignore"];
}

/** Minimal child-process view so the backend order can be tested directly. */
export interface ClipboardProcess {
  /** Settles with the exit status, or rejects when the command cannot start. */
  readonly exited: Promise<number | null>;
  /** Terminate after a timeout or cancellation. Best effort, never throws. */
  kill(): void;
}

export type ClipboardSpawn = (
  command: string,
  args: readonly string[],
  options: ClipboardSpawnOptions,
) => ClipboardProcess;

export interface NativeClipboardOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly release?: string;
  readonly spawn?: ClipboardSpawn;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** A hung clipboard command must not stall the composer indefinitely. */
export const CLIPBOARD_TIMEOUT_MS = 2_000;

interface ClipboardCandidate {
  readonly backend: ClipboardBackend;
  readonly command: string;
  readonly args: readonly string[];
}

const runClipboardCommand: ClipboardSpawn = (command, args, options) => {
  const child = spawn(command, args, {
    shell: options.shell,
    stdio: [...options.stdio],
  });
  child.stdin?.end(options.input);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  return {
    exited,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have already exited.
      }
    },
  };
};

function isWsl(
  env: Readonly<Record<string, string | undefined>>,
  release: string,
): boolean {
  return Boolean(
    env.WSL_DISTRO_NAME ||
      env.WSL_INTEROP ||
      release.toLowerCase().includes("microsoft"),
  );
}

function clipboardCandidates(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  release: string,
): readonly ClipboardCandidate[] {
  const candidates: ClipboardCandidate[] = [];

  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) {
      candidates.push({ backend: "wl-copy", command: "wl-copy", args: [] });
    }
    if (env.DISPLAY) {
      candidates.push(
        {
          backend: "xclip",
          command: "xclip",
          args: ["-selection", "clipboard"],
        },
        {
          backend: "xsel",
          command: "xsel",
          args: ["--clipboard", "--input"],
        },
      );
    }
    if (isWsl(env, release)) {
      candidates.push({ backend: "clip.exe", command: "clip.exe", args: [] });
    }
  } else if (platform === "darwin") {
    candidates.push({ backend: "pbcopy", command: "pbcopy", args: [] });
  } else if (platform === "win32") {
    candidates.push({ backend: "clip.exe", command: "clip.exe", args: [] });
  }

  return candidates;
}

type CandidateOutcome = "copied" | "failed" | "aborted";

async function tryCandidate(
  candidate: ClipboardCandidate,
  value: string,
  spawnCommand: ClipboardSpawn,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<CandidateOutcome> {
  if (signal?.aborted) return "aborted";

  let child: ClipboardProcess;
  try {
    child = spawnCommand(candidate.command, candidate.args, {
      input: value,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    // Missing or broken clipboard commands are expected; try the next one.
    return "failed";
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<CandidateOutcome>((resolve) => {
    timer = setTimeout(() => {
      child.kill();
      resolve("failed");
    }, timeoutMs);
    timer.unref?.();
  });
  const aborted = new Promise<CandidateOutcome>((resolve) => {
    if (!signal) return;
    onAbort = () => {
      child.kill();
      resolve("aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([
      child.exited.then(
        (code): CandidateOutcome => (code === 0 ? "copied" : "failed"),
      ),
      timeout,
      aborted,
    ]);
  } catch {
    return "failed";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Copy through the first available OS clipboard command, without invoking a
 * shell. A backend that hangs past `timeoutMs` is terminated and the next
 * candidate is tried, so the caller never blocks on a wedged command.
 */
export async function copyToNativeClipboard(
  value: string,
  options: NativeClipboardOptions = {},
): Promise<NativeClipboardResult | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const release = options.release ?? osRelease();
  const spawnCommand = options.spawn ?? runClipboardCommand;
  const timeoutMs = options.timeoutMs ?? CLIPBOARD_TIMEOUT_MS;
  const signal = options.signal;

  for (const candidate of clipboardCandidates(platform, env, release)) {
    if (signal?.aborted) return null;
    const outcome = await tryCandidate(
      candidate,
      value,
      spawnCommand,
      timeoutMs,
      signal,
    );
    if (outcome === "copied") return { backend: candidate.backend };
    if (outcome === "aborted") return null;
  }

  return null;
}
