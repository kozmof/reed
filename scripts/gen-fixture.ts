#!/usr/bin/env node
/**
 * CLI script: generate a large text fixture file for performance tests.
 *
 * Usage (via tsx / ts-node / node --import):
 *   npx tsx scripts/gen-fixture.ts [options]
 *
 * Options:
 *   --lines  <n>              Number of lines     (default: 100000)
 *   --pattern prose|code|uniform|random           (default: prose)
 *   --seed   <n>              RNG seed            (default: 42)
 *   --crlf                    Use CRLF line endings
 *   --out    <path>           Output path         (default: tmp/large.txt)
 *
 * Example:
 *   npx tsx scripts/gen-fixture.ts --lines 200000 --pattern code --out tmp/code.txt
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { generateLargeContent, approximateByteSize } from "../src/test-utils/large-content.ts";

// ---------------------------------------------------------------------------
// Arg parsing (no dependencies — keep this script zero-dep)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const has = (flag: string) => args.includes(flag);

  return {
    lines: parseInt(get("--lines") ?? "100000", 10),
    pattern: (get("--pattern") ?? "prose") as "prose" | "code" | "uniform" | "random",
    seed: parseInt(get("--seed") ?? "42", 10),
    crlf: has("--crlf"),
    out: get("--out") ?? "tmp/large.txt",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv);

console.log(
  `Generating ${opts.lines.toLocaleString()} lines [pattern=${opts.pattern} seed=${opts.seed}]...`,
);

const start = performance.now();
const content = generateLargeContent({
  lineCount: opts.lines,
  pattern: opts.pattern,
  seed: opts.seed,
  lineEnding: opts.crlf ? "\r\n" : "\n",
});
const genMs = (performance.now() - start).toFixed(1);

const bytes = approximateByteSize(content);
const kb = (bytes / 1024).toFixed(1);
const mb = (bytes / 1024 / 1024).toFixed(2);

// Write
mkdirSync(dirname(opts.out), { recursive: true });
const writeStart = performance.now();
writeFileSync(opts.out, content, "utf-8");
const writeMs = (performance.now() - writeStart).toFixed(1);

console.log(`  Generated : ${genMs} ms`);
console.log(`  Written   : ${writeMs} ms  →  ${opts.out}`);
console.log(`  Size      : ~${kb} KB (${mb} MB)`);
console.log(`  Lines     : ${opts.lines.toLocaleString()}`);
