// Strict YAML loading for policy and engagement files: YAML 1.2 core schema, unique keys,
// no aliases (an alias makes a value's meaning depend on another node), no custom tags.

import { parseDocument } from "yaml";
import { UsageError } from "./errors.js";

export function parseYaml(text: string, source: string): unknown {
  const doc = parseDocument(text, { schema: "core", uniqueKeys: true, strict: true, prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new UsageError(`${source}: ${doc.errors[0]?.message ?? "invalid YAML"}`);
  }
  // maxAliasCount 0: any alias reference is a hard error rather than an expansion.
  try {
    return doc.toJS({ maxAliasCount: 0 });
  } catch (e) {
    throw new UsageError(`${source}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
