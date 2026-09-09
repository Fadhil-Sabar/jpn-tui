import { spawnSync } from "node:child_process";
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

export type ClipboardCopy = (value: string) => NativeClipboardResult | null;

export interface ClipboardSpawnOptions {
  readonly input: string;
  readonly encoding: "utf8";
  readonly shell: false;
  readonly stdio: ["pipe", "ignore", "ignore"];
}

export type ClipboardSpawnSync = (
  command: string,
  args: readonly string[],
  options: ClipboardSpawnOptions,
) => { readonly status: number | null };

export interface NativeClipboardOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly release?: string;
  readonly spawn?: ClipboardSpawnSync;
}

interface ClipboardCandidate {
  readonly backend: ClipboardBackend;
  readonly command: string;
  readonly args: readonly string[];
}

const runClipboardCommand: ClipboardSpawnSync = (command, args, options) =>
  spawnSync(command, args, options);

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

/** Copy through the first available OS clipboard command, without invoking a shell. */
export function copyToNativeClipboard(
  value: string,
  options: NativeClipboardOptions = {},
): NativeClipboardResult | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const release = options.release ?? osRelease();
  const spawn = options.spawn ?? runClipboardCommand;

  for (const candidate of clipboardCandidates(platform, env, release)) {
    try {
      const result = spawn(candidate.command, candidate.args, {
        input: value,
        encoding: "utf8",
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (result.status === 0) return { backend: candidate.backend };
    } catch {
      // Missing or broken clipboard commands are expected; try the next one.
    }
  }

  return null;
}
