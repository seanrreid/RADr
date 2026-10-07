// One Ajv instance, schemas compiled once. Validators throw a caller-chosen RadrError subclass
// so a bad engagement.yml is a usage error (exit 2) while a bad event log is a refusal (exit 1).

import { Ajv, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv";
import type { RadrError } from "../core/errors.js";

const ajv = new Ajv({ strict: true, allErrors: false, allowUnionTypes: false });

export const SHA256 = "^sha256:[0-9a-f]{64}$";
export const ISO_UTC = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
export const SLUG = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";
export const GIT_SHA = "^[0-9a-f]{40}$";

export type Validator<T> = (value: unknown, where: string) => T;

export function makeValidator<T>(schema: AnySchema, errorType: new (message: string) => RadrError): Validator<T> {
  const fn: ValidateFunction = ajv.compile(schema);
  return (value, where) => {
    if (fn(value)) return value as T;
    throw new errorType(`${where}: ${describe(fn.errors?.[0])}`);
  };
}

function describe(err: ErrorObject | undefined): string {
  if (err === undefined) return "invalid";
  const at = err.instancePath === "" ? "(root)" : err.instancePath;
  const extra = err.keyword === "additionalProperties" ? ` "${String(err.params["additionalProperty"])}"` : "";
  return `${at} ${err.message ?? err.keyword}${extra}`;
}
