// toolchain/manifest.yml loader (T3.1).

import { readAsset } from "../core/assets.js";
import { InternalError, RefusedError } from "../core/errors.js";
import { parseYaml } from "../core/yaml.js";
import { makeValidator } from "../schemas/validate.js";

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface PlatformAsset {
  readonly url: string;
  readonly sha256: string;
  readonly archive: "tar.gz" | "binary";
  readonly bin: string;
}

export interface ToolEntry {
  readonly version: string;
  readonly license: string;
  readonly source: string;
  readonly checksums_from: string;
  readonly version_args: readonly string[];
  readonly version_pattern: string;
  readonly platforms: Readonly<Record<Platform, PlatformAsset>>;
}

export interface Manifest {
  readonly version: 1;
  readonly tools: Readonly<Record<string, ToolEntry>>;
}

const asset = {
  type: "object",
  additionalProperties: false,
  required: ["url", "sha256", "archive", "bin"],
  properties: {
    url: { type: "string", pattern: "^https://github\\.com/" },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    archive: { enum: ["tar.gz", "binary"] },
    bin: { type: "string", pattern: "^[A-Za-z0-9._/-]+$", not: { pattern: "(^/|\\.\\.)" } },
  },
};

const validate = makeValidator<Manifest>(
  {
    type: "object",
    additionalProperties: false,
    required: ["version", "tools"],
    properties: {
      version: { const: 1 },
      tools: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["version", "license", "source", "checksums_from", "version_args", "version_pattern", "platforms"],
          properties: {
            version: { type: "string" },
            license: { type: "string" },
            source: { type: "string" },
            checksums_from: { type: "string" },
            version_args: { type: "array", items: { type: "string" } },
            version_pattern: { type: "string" },
            platforms: {
              type: "object",
              additionalProperties: false,
              required: [...PLATFORMS],
              properties: Object.fromEntries(PLATFORMS.map((p) => [p, asset])),
            },
          },
        },
      },
    },
  },
  InternalError,
);

export function loadManifest(): Manifest {
  return validate(parseYaml(readAsset("toolchain/manifest.yml"), "toolchain/manifest.yml"), "toolchain/manifest.yml");
}

export function currentPlatform(): Platform {
  const key = `${process.platform}-${process.arch}`;
  if (!(PLATFORMS as readonly string[]).includes(key)) throw new RefusedError(`unsupported platform ${key} (supported: ${PLATFORMS.join(", ")})`);
  return key as Platform;
}
