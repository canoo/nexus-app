import { accessSync, constants, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Binary-first CLI location (sharing contract A): the app talks to the
// installed `nexus` binary through `nexus control --json` (protocol v1).
// Resolution order, first hit wins:
//   1. NEXUS_CONTROL_BINARY — explicit absolute path, always honoured.
//   2. `nexus` on PATH — the curl installer's documented location
//      ($HOME/.local/bin) once it is on PATH.
//   3. $HOME/.local/bin/nexus — the legacy default the control adapter used
//      to hard-code; kept as the last resort so a missing binary fails in the
//      same place it always did (spawn fails closed, never a shell fallback).
// A repo checkout is only a fallback: NEXUS_CONTROL_ROOT (or the curl
// installer's clone at $HOME/.config/nexus/repo) identifies the trusted full
// CLI repository for operations the installed binary cannot do alone —
// today, `companion.command` shells out to the CLI's node helpers under that
// root server-side. See vendor/observability-store/README.md.
const CLI_MARKERS = ["core/NEXUS.md", "tools/mcp/server.mjs"];

function isExecutableFile(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name, pathValue) {
  if (typeof pathValue !== "string" || pathValue.length === 0) return null;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Absolute path of the installed `nexus` binary; never a shell lookup. */
export function resolveControlBinary({ home = homedir(), env = process.env } = {}) {
  const explicit = env?.NEXUS_CONTROL_BINARY;
  if (typeof explicit === "string" && explicit.length > 0 && explicit.startsWith("/")) {
    return explicit;
  }
  const onPath = findOnPath("nexus", env?.PATH);
  if (onPath) return onPath;
  return join(home, ".local", "bin", "nexus");
}

/** Absolute path of the trusted full CLI checkout, or null when there is none. */
export function resolveControlRoot({ home = homedir(), env = process.env } = {}) {
  const candidates = [];
  const explicit = env?.NEXUS_CONTROL_ROOT;
  if (typeof explicit === "string" && explicit.length > 0) candidates.push(explicit);
  // Legacy name for the same checkout; the curl installer clones here.
  const legacy = env?.NEXUS_REPO;
  if (typeof legacy === "string" && legacy.length > 0) candidates.push(legacy);
  candidates.push(join(home, ".config", "nexus", "repo"));
  for (const candidate of candidates) {
    if (!candidate.startsWith("/")) continue;
    try {
      if (!lstatSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    const hasMarkers = CLI_MARKERS.every((marker) => {
      try {
        return lstatSync(join(candidate, marker)).isFile();
      } catch {
        return false;
      }
    });
    if (hasMarkers) return candidate;
  }
  return null;
}
