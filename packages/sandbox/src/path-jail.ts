export const sandboxBackend = "path-jail";

export type PathLook = {
  realPath(absolutePath: string): string | null | { error: string };
};

export type PathJailDecision =
  | { allowed: true; relativePath: string; absolutePath: string }
  | { allowed: false; requestedPath: string; reason: "outside" | "invalid" };

type Style = "windows" | "posix";

type AbsolutePath = { root: string; segments: string[] };

export function containPath(workspaceRoot: string, requested: string, look: PathLook): PathJailDecision {
  const style = pathStyle(workspaceRoot);
  const workspace = splitAbsolute(workspaceRoot, style);
  if (!workspace || requested.includes("\0")) {
    return deny(requested, "invalid");
  }
  const realRoot = walk(workspace.root, workspace.segments, look, style);
  if (!realRoot) {
    return deny(requested, "invalid");
  }
  const target = classify(requested, style, realRoot);
  if (target.kind === "invalid") {
    return deny(requested, "invalid");
  }
  const resolved = target.kind === "relative"
    ? walk(realRoot, target.segments, look, style)
    : walk(target.root, target.segments, look, style);
  if (!resolved) {
    return deny(requested, "invalid");
  }
  if (!isInside(realRoot, resolved, style)) {
    return deny(requested, "outside");
  }
  return {
    allowed: true,
    relativePath: relativePath(realRoot, resolved, style),
    absolutePath: present(resolved, style),
  };
}

function deny(requestedPath: string, reason: "outside" | "invalid"): PathJailDecision {
  return { allowed: false, requestedPath, reason };
}

function pathStyle(workspaceRoot: string): Style {
  return /^[A-Za-z]:[\\/]/.test(workspaceRoot) || /^[\\/]{2}/.test(workspaceRoot) ? "windows" : "posix";
}

function classify(
  requested: string,
  style: Style,
  realRoot: string,
): { kind: "relative"; segments: string[] } | ({ kind: "absolute" } & AbsolutePath) | { kind: "invalid" } {
  if (requested === "" || requested === ".") {
    return { kind: "relative", segments: [] };
  }
  if (style === "windows") {
    if (/^[\\/]{2}\?[\\/]/.test(requested) || /^[\\/]{2}\.[\\/]/.test(requested) || /^[A-Za-z]:[^\\/]/.test(requested)) {
      return { kind: "invalid" };
    }
    const absolute = splitAbsolute(requested, style);
    if (absolute) {
      return { kind: "absolute", ...absolute };
    }
    if (/^[\\/]/.test(requested)) {
      const drive = /^([A-Za-z]:\/)/.exec(realRoot);
      if (!drive) {
        return { kind: "invalid" };
      }
      return { kind: "absolute", root: drive[1].toUpperCase(), segments: splitSegments(requested) };
    }
    return { kind: "relative", segments: splitSegments(requested) };
  }
  if (/^[A-Za-z]:/.test(requested)) {
    return { kind: "invalid" };
  }
  if (requested.startsWith("/") || requested.startsWith("\\")) {
    const absolute = splitAbsolute(requested, style);
    return absolute ? { kind: "absolute", ...absolute } : { kind: "invalid" };
  }
  return { kind: "relative", segments: splitSegments(requested) };
}

function splitAbsolute(input: string, style: Style): AbsolutePath | null {
  const text = normalizeSlashes(input);
  if (style === "windows") {
    const drive = /^([A-Za-z]):\/(.*)$/.exec(text);
    if (drive) {
      return { root: `${drive[1].toUpperCase()}:/`, segments: splitSegments(drive[2]) };
    }
    const unc = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(text);
    if (unc) {
      return { root: `//${unc[1]}/${unc[2]}`, segments: splitSegments(unc[3] ?? "") };
    }
    return null;
  }
  if (!text.startsWith("/")) {
    return null;
  }
  return { root: "/", segments: splitSegments(text.slice(1)) };
}

function splitSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
}

function walk(start: string, segments: string[], look: PathLook, style: Style): string | null {
  let current = stripTrailingSlash(normalizeSlashes(start), style);
  for (const raw of segments) {
    const segment = style === "windows" ? windowsSegment(raw) : raw;
    if (segment === null) {
      return null;
    }
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      current = parentPath(current, style);
      continue;
    }
    const next = joinPath(current, segment, style);
    const looked = lookup(look, next);
    if (looked === "error") {
      return null;
    }
    current = looked ?? next;
  }
  return current;
}

function lookup(look: PathLook, absolutePath: string): string | null | "error" {
  let looked: ReturnType<PathLook["realPath"]>;
  try {
    looked = look.realPath(absolutePath);
  } catch {
    return "error";
  }
  if (looked === null) {
    return null;
  }
  if (typeof looked === "string") {
    const normalized = stripTrailingSlash(normalizeSlashes(looked), pathStyle(looked));
    return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) ? normalized : "error";
  }
  return "error";
}

function windowsSegment(segment: string): string | null {
  if (segment === "." || segment === "..") {
    return segment;
  }
  const trimmed = segment.replace(/[ .]+$/g, "");
  if (trimmed.length === 0 || trimmed.includes(":") || trimmed.includes("\0")) {
    return null;
  }
  return trimmed;
}

function joinPath(current: string, segment: string, style: Style): string {
  if (style === "posix" && current === "/") {
    return `/${segment}`;
  }
  const base = current.endsWith("/") ? current.slice(0, -1) : current;
  return `${base}/${segment}`;
}

function parentPath(current: string, style: Style): string {
  const parts = splitAbsolute(current, style);
  if (!parts || parts.segments.length === 0) {
    return parts?.root ?? current;
  }
  return joinRoot(parts.root, parts.segments.slice(0, -1));
}

function joinRoot(root: string, segments: string[]): string {
  if (segments.length === 0) {
    return root;
  }
  if (root === "/") {
    return `/${segments.join("/")}`;
  }
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${base}/${segments.join("/")}`;
}

function isInside(root: string, candidate: string, style: Style): boolean {
  const base = compareKey(root, style);
  const child = compareKey(candidate, style);
  if (child === base) {
    return true;
  }
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return child.startsWith(prefix);
}

function relativePath(root: string, target: string, style: Style): string {
  const base = compareKey(root, style);
  const child = compareKey(target, style);
  if (child === base) {
    return "";
  }
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const presented = present(target, style);
  return presented.slice(prefix.length);
}

function compareKey(path: string, style: Style): string {
  let text = stripTrailingSlash(normalizeSlashes(path), style);
  if (style === "windows") {
    text = text.toLowerCase();
  }
  return text;
}

function present(path: string, style: Style): string {
  const text = stripTrailingSlash(normalizeSlashes(path), style);
  if (style === "windows") {
    return text.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  }
  return text;
}

function normalizeSlashes(path: string): string {
  let text = path.replaceAll("\\", "/");
  if (text.toLowerCase().startsWith("//?/unc/")) {
    text = `//${text.slice("//?/unc/".length)}`;
  } else if (text.toLowerCase().startsWith("//?/")) {
    text = text.slice(4);
  }
  return text;
}

function stripTrailingSlash(path: string, style: Style): string {
  if (path === "/" || /^[A-Za-z]:\/$/.test(path)) {
    return style === "windows" ? path.toUpperCase() : path;
  }
  return path.endsWith("/") ? path.slice(0, -1) : path;
}
