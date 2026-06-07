import type { ToolRegistry } from "./registry.js";
import { fsEdit, fsList, fsRead, fsWrite } from "./core/fs.js";
import { shellExec } from "./core/shell.js";
import { httpFetch } from "./core/http.js";
import { memorySearch, memoryStore, sessionsSend, timeNow } from "./core/misc.js";

export * from "./registry.js";
export { fsEdit, fsList, fsRead, fsWrite, resolveInWorkspace } from "./core/fs.js";
export { shellExec } from "./core/shell.js";
export { httpFetch } from "./core/http.js";
export { memorySearch, memoryStore, sessionsSend, timeNow } from "./core/misc.js";

/** The 10 built-in core tools (spec Phase 1). */
export const CORE_TOOLS = [
  fsRead,
  fsWrite,
  fsEdit,
  fsList,
  shellExec,
  httpFetch,
  timeNow,
  memoryStore,
  memorySearch,
  sessionsSend,
] as const;

export function registerCoreTools(registry: ToolRegistry): ToolRegistry {
  for (const tool of CORE_TOOLS) registry.register(tool);
  return registry;
}
