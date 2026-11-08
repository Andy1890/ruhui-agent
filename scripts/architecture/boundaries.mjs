export const packages = [
  "core",
  "providers",
  "sandbox",
  "tools",
  "mcp",
  "orchestration",
  "server",
  "sdk",
  "cli",
];

const targetAllowed = {
  core: [],
  providers: ["core"],
  sandbox: ["core"],
  tools: ["core", "sandbox"],
  mcp: ["core", "tools"],
  orchestration: ["core"],
  server: ["core", "providers", "sandbox", "tools", "mcp", "orchestration"],
  sdk: ["server"],
  cli: ["server", "sdk"],
};

const phase0Allowed = {
  ...targetAllowed,
  sdk: ["core", "providers", "sandbox", "tools"],
};

export function findViolations(graph, phase = "target") {
  const allowed = phase === "phase0" ? phase0Allowed : targetAllowed;
  const violations = [];
  for (const [from, dependencies] of Object.entries(graph)) {
    if (!packages.includes(from)) {
      violations.push({ from, to: null, rule: "unknown-package" });
      continue;
    }
    for (const to of dependencies) {
      if (!packages.includes(to)) {
        violations.push({ from, to, rule: "unknown-package" });
      } else if (!allowed[from].includes(to)) {
        violations.push({ from, to, rule: "forbidden-dependency" });
      }
    }
  }
  return violations;
}
