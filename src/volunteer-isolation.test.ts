import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The volunteer system must never be reachable from the functions that serve
 * the live event bot and website. If it were, those functions would load the
 * PDF libraries on every cold start (slowing them down, which is what makes
 * Slack's short trigger_id expire) and a problem in volunteer code could take
 * them down. This walks each existing entry point's imports and fails if it
 * reaches any volunteer file or a PDF library.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const importPattern =
  /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm;

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];

    if (specifier) {
      found.push(specifier);
    }
  }

  return found;
}

function resolveLocal(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];

  return candidates.find((candidate) => existsSync(candidate) && candidate.endsWith(".ts")) ?? null;
}

function reachableFrom(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();

    if (!file || files.has(file)) {
      continue;
    }

    files.add(file);

    for (const specifier of importsOf(file)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveLocal(file, specifier);

        if (resolved) {
          queue.push(resolved);
        }
      } else if (!specifier.startsWith("node:")) {
        packages.add(specifier);
      }
    }
  }

  return { files, packages };
}

const volunteerEntryPoints = new Set(["api/slack-volunteers.ts", "src/volunteer-index.ts"]);
const existingEntryPoints = [
  ...readdirSync(path.join(root, "api"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `api/${name}`),
  "src/index.ts",
].filter((entry) => !volunteerEntryPoints.has(entry));

describe("the volunteer system stays out of the live bot and website functions", () => {
  it("checks the entry points it is meant to", () => {
    for (const expected of ["api/slack.ts", "api/jummah.ts", "api/events.ts", "src/index.ts"]) {
      assert.ok(existingEntryPoints.includes(expected), `${expected} is not being checked`);
    }
  });

  for (const entry of existingEntryPoints) {
    it(`${entry} reaches no volunteer code or PDF library`, () => {
      const { files, packages } = reachableFrom(path.join(root, entry));
      const volunteerFiles = [...files]
        .map((file) => path.relative(root, file))
        .filter((file) => /volunteer/i.test(file));
      const pdfPackages = [...packages].filter((name) =>
        /pdf-lib|fontkit|dejavu/i.test(name),
      );

      assert.deepEqual(volunteerFiles, []);
      assert.deepEqual(pdfPackages, []);
    });
  }

  it("does reach them from the volunteer entry points (so the check can tell the difference)", () => {
    for (const entry of volunteerEntryPoints) {
      const { files, packages } = reachableFrom(path.join(root, entry));

      assert.ok(
        [...files].some((file) => /volunteer-app\.ts$/.test(file)),
        `${entry} should reach the volunteer app`,
      );
      assert.ok(
        [...packages].some((name) => name === "pdf-lib"),
        `${entry} should reach pdf-lib`,
      );
    }
  });
});
