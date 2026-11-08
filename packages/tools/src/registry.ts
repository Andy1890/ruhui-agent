import type { JsonSchema } from "./schema.js";

export const toolPermissions = ["read", "write", "execute", "network", "approval"] as const;
export type ToolPermission = (typeof toolPermissions)[number];
export type ToolConcurrency = "parallel" | "serial";

export type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  permissions: readonly ToolPermission[];
  concurrency: ToolConcurrency;
  aliases: readonly string[];
};

const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const text = (description: string): JsonSchema => ({ type: "string", description });

export const phase0Tools: readonly RegisteredTool[] = [
  {
    name: "read_file",
    description: "读取工作区内的文本",
    permissions: ["read"],
    concurrency: "parallel",
    aliases: ["read", "cat"],
    inputSchema: objectSchema({ path: text("工作区内的路径") }, ["path"]),
  },
  {
    name: "write_file",
    description: "创建或覆盖工作区内的文件",
    permissions: ["write"],
    concurrency: "serial",
    aliases: ["write"],
    inputSchema: objectSchema({ path: text("工作区内的路径"), content: text("文件内容") }, ["path", "content"]),
  },
  {
    name: "edit_file",
    description: "按精确片段替换工作区内的文件",
    permissions: ["write"],
    concurrency: "serial",
    aliases: ["edit"],
    inputSchema: objectSchema(
      { path: text("工作区内的路径"), old: text("要替换的原文"), new: text("替换后的文本") },
      ["path", "old", "new"],
    ),
  },
  {
    name: "list_dir",
    description: "列出目录。省略 path 时由处理函数列出工作区根",
    permissions: ["read"],
    concurrency: "parallel",
    aliases: ["ls", "dir", "list"],
    inputSchema: objectSchema({ path: text("工作区内的目录，可省略") }),
  },
  {
    name: "search_files",
    description: "在工作区内按名称和文本搜索",
    permissions: ["read"],
    concurrency: "parallel",
    aliases: ["search", "grep"],
    inputSchema: objectSchema({ query: text("搜索文本") }, ["query"]),
  },
  {
    name: "execute_command",
    description: "按参数数组执行命令，默认不经过外壳",
    permissions: ["execute"],
    concurrency: "serial",
    aliases: ["shell", "bash"],
    inputSchema: objectSchema(
      {
        args: { type: "array", items: { type: "string" }, description: "参数数组" },
        shell: { type: "string", enum: ["none", "pwsh", "bash"], description: "默认 none" },
      },
      ["args"],
    ),
  },
  {
    name: "update_plan",
    description: "改写当前 Turn 的步骤清单",
    permissions: ["read"],
    concurrency: "serial",
    aliases: ["plan"],
    inputSchema: objectSchema(
      {
        steps: {
          type: "array",
          items: objectSchema({ title: text("步骤"), status: text("状态，可省略") }, ["title"]),
          description: "步骤清单",
        },
      },
      ["steps"],
    ),
  },
  {
    name: "ask_user",
    description: "向使用者提一个明确问题并挂起",
    permissions: ["approval"],
    concurrency: "serial",
    aliases: ["ask"],
    inputSchema: objectSchema({ question: text("要提的问题") }, ["question"]),
  },
];

const byName = new Map(phase0Tools.map((tool) => [tool.name, tool]));
const byAlias = new Map(phase0Tools.flatMap((tool) => tool.aliases.map((alias) => [alias, tool] as const)));

export function resolveToolName(name: string): RegisteredTool | null {
  const normalized = normalizeName(name);
  return byName.get(normalized) ?? byAlias.get(normalized) ?? null;
}

export function closestToolName(name: string): string {
  const target = normalizeName(name);
  let best = phase0Tools[0].name;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tool of phase0Tools) {
    const distance = editDistance(target, tool.name);
    if (distance < bestDistance || (distance === bestDistance && tool.name < best)) {
      best = tool.name;
      bestDistance = distance;
    }
  }
  return best;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replaceAll("-", "_");
}

function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let row = 0; row < rows.length; row += 1) {
    rows[row][0] = row;
  }
  for (let column = 0; column < right.length + 1; column += 1) {
    rows[0][column] = column;
  }
  for (let row = 1; row < rows.length; row += 1) {
    for (let column = 1; column < right.length + 1; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(rows[row - 1][column] + 1, rows[row][column - 1] + 1, rows[row - 1][column - 1] + cost);
    }
  }
  return rows[left.length][right.length];
}
