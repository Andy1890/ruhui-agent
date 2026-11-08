import { fail, ok, type Result } from "./result.js";
import { schemaVersion, sessionIdPattern, utcTimePattern } from "./schema-version.js";

export type Session = {
  schemaVersion: typeof schemaVersion;
  id: string;
  workspaceRoot: string;
  createdAt: string;
  runtimeVersion: string;
  parentSessionId: null;
  instructionHashes: readonly string[];
};

export type SessionInput = {
  id: string;
  workspaceRoot: string;
  createdAt: string;
  runtimeVersion: string;
  instructionHashes?: readonly string[];
  parentSessionId?: string | null;
};

export function createSession(input: SessionInput): Result<Session> {
  if (!sessionIdPattern.test(input.id)) {
    return fail("session-id");
  }
  if (input.workspaceRoot.trim() === "") {
    return fail("workspace");
  }
  if (!utcTimePattern.test(input.createdAt)) {
    return fail("time");
  }
  if (input.runtimeVersion.trim() === "") {
    return fail("runtime-version");
  }
  if (input.parentSessionId != null) {
    return fail("parent-session");
  }
  return ok({
    schemaVersion,
    id: input.id,
    workspaceRoot: input.workspaceRoot,
    createdAt: input.createdAt,
    runtimeVersion: input.runtimeVersion,
    parentSessionId: null,
    instructionHashes: [...(input.instructionHashes ?? [])],
  });
}
