import fs from "node:fs";

const schemaKeywords = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "minimum",
  "minLength",
  "pattern",
]);

export function loadSchema(schemaPath) {
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

export function validateConfig(schema, value) {
  assertSupportedSchema(schema);
  return validateNode(schema, value, "$");
}

function assertSupportedSchema(schema) {
  for (const key of Object.keys(schema)) {
    if (!schemaKeywords.has(key)) {
      throw new Error(`配置 Schema 使用了尚未实现的关键字 ${key}`);
    }
  }
  for (const property of Object.values(schema.properties ?? {})) {
    assertSupportedSchema(property);
  }
}

function validateNode(schema, value, pointer) {
  const errors = [];
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`${pointer} 必须是 ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pointer} 必须是 ${schema.enum.join(" 或 ")}`);
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${pointer} 必须是对象`);
      return errors;
    }
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${pointer}.${key} 缺少`);
      }
    }
    if (schema.additionalProperties !== false) {
      throw new Error(`${pointer} 的对象必须关闭额外字段`);
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        errors.push(`${pointer}.${key} 是未允许的字段`);
        continue;
      }
      errors.push(...validateNode(properties[key], value[key], `${pointer}.${key}`));
    }
    return errors;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${pointer} 必须是字符串`);
      return errors;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer} 不能为空`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${pointer} 不符合 ${schema.pattern}`);
    }
  }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push(`${pointer} 必须是整数`);
      return errors;
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${pointer} 必须大于或等于 ${schema.minimum}`);
    }
  }
  return errors;
}
