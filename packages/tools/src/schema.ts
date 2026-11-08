export type JsonSchema =
  | { type: "string"; description?: string; enum?: readonly string[] }
  | { type: "array"; description?: string; items?: JsonSchema }
  | {
      type: "object";
      description?: string;
      properties?: Record<string, JsonSchema>;
      required?: readonly string[];
      additionalProperties?: boolean;
    };

export function schemaProblems(schema: JsonSchema, value: unknown, label = "参数"): string[] {
  if (schema.type === "string") {
    if (typeof value !== "string") {
      return [phrase(label, "必须是字符串")];
    }
    if (schema.enum && !schema.enum.includes(value)) {
      return [phrase(label, `必须是 ${joinChoices(schema.enum)}`)];
    }
    return [];
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      return [phrase(label, schema.items?.type === "string" ? "必须是字符串数组" : "必须是数组")];
    }
    if (!schema.items) {
      return [];
    }
    for (const item of value) {
      const nested = schemaProblems(schema.items, item, `${label} 的每一项`);
      if (nested.length > 0) {
        return nested;
      }
    }
    return [];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [phrase(label, "必须是对象")];
  }
  const source = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const problems: string[] = [];
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(source).sort()) {
      if (!Object.hasOwn(properties, key)) {
        problems.push(`存在未知字段 ${key}`);
      }
    }
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(source, key) || source[key] === undefined) {
      problems.push(`缺少 ${key}（${properties[key] ? typeLabel(properties[key]) : "字段"}）`);
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    if (!Object.hasOwn(source, key) || source[key] === undefined) {
      continue;
    }
    problems.push(...schemaProblems(child, source[key], key));
  }
  return problems;
}

function typeLabel(schema: JsonSchema): string {
  if (schema.type === "string") {
    return "字符串";
  }
  if (schema.type === "array" && schema.items?.type === "string") {
    return "字符串数组";
  }
  if (schema.type === "array") {
    return "数组";
  }
  return "对象";
}

function phrase(label: string, rest: string): string {
  const gap = /^[A-Za-z][A-Za-z0-9_]*$/.test(label) ? " " : "";
  return `${label}${gap}${rest}`;
}

function joinChoices(values: readonly string[]): string {
  if (values.length <= 1) {
    return values[0] ?? "";
  }
  return `${values.slice(0, -1).join("、")} 或 ${values[values.length - 1]}`;
}
