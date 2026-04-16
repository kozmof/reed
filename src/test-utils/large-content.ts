/**
 * Utilities for generating large document content in performance tests.
 *
 * Content is returned as a plain string so it can be passed directly to
 * createInitialState({ content }) or written to disk via gen-fixture script.
 */

/** Simple LCG RNG — same algorithm used in store.usecase.test.ts */
export function makeDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export interface LargeContentOptions {
  /** Number of lines to generate (default: 100_000) */
  lineCount?: number;
  /**
   * Content pattern:
   *  - 'prose'     – variable-length English-like sentences (ASCII only)
   *  - 'code'      – indented code-like lines with identifiers and numbers
   *  - 'uniform'   – every line is identical (stress-tests deduplication paths)
   *  - 'random'    – random printable ASCII of varying widths
   *  - 'multibyte' – mixed ASCII, kanji (3 bytes/char), and emoji (4 bytes/char)
   *                  byte length >> UTF-16 length; exercises offset translation paths
   */
  pattern?: "prose" | "code" | "uniform" | "random" | "multibyte";
  /** RNG seed for deterministic output (default: 42) */
  seed?: number;
  /** Line ending to use (default: '\n') */
  lineEnding?: "\n" | "\r\n";
}

// ---------------------------------------------------------------------------
// Pattern generators
// ---------------------------------------------------------------------------

const WORDS = [
  "the",
  "quick",
  "brown",
  "fox",
  "jumps",
  "over",
  "lazy",
  "dog",
  "document",
  "editor",
  "line",
  "index",
  "piece",
  "table",
  "buffer",
  "insert",
  "delete",
  "replace",
  "undo",
  "redo",
  "cursor",
  "selection",
  "text",
  "content",
  "range",
  "offset",
  "length",
  "version",
  "state",
];

function proseWord(rng: () => number): string {
  return WORDS[Math.floor(rng() * WORDS.length)];
}

function proseLine(rng: () => number): string {
  const wordCount = 4 + Math.floor(rng() * 12); // 4–15 words
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(proseWord(rng));
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
}

const KEYWORDS = ["const", "let", "function", "return", "if", "else", "for", "while"];
const IDENTIFIERS = ["value", "index", "node", "offset", "length", "count", "result", "state"];

function codeLine(rng: () => number, lineIndex: number): string {
  const indent = "  ".repeat(Math.floor(rng() * 3));
  const keyword = KEYWORDS[Math.floor(rng() * KEYWORDS.length)];
  const ident = IDENTIFIERS[Math.floor(rng() * IDENTIFIERS.length)];
  const num = Math.floor(rng() * 1000);
  return `${indent}${keyword} ${ident}${lineIndex} = ${num}; // line ${lineIndex}`;
}

function randomLine(rng: () => number): string {
  const len = 10 + Math.floor(rng() * 120); // 10–129 chars
  let s = "";
  for (let i = 0; i < len; i++) {
    // printable ASCII: 0x21–0x7e (skip space at boundaries for readability)
    s += String.fromCharCode(0x21 + Math.floor(rng() * 94));
  }
  return s;
}

// Kanji words (each kanji is 3 bytes in UTF-8, 1 UTF-16 code unit)
const KANJI_WORDS = [
  "日本語",
  "世界",
  "漢字",
  "文字",
  "編集",
  "東京",
  "言語",
  "文章",
  "行列",
  "開発",
  "挿入",
  "削除",
  "選択",
  "検索",
  "保存",
];

// Emoji tokens (each base emoji is 4 bytes in UTF-8, 2 UTF-16 code units — a surrogate pair)
const EMOJI_POOL = [
  "😀",
  "🎉",
  "🚀",
  "💻",
  "📝",
  "🌟",
  "🎯",
  "🔥",
  "💡",
  "🌍",
  "✨",
  "🦊",
  "🐉",
  "🍎",
  "🎵",
];

const ASCII_TOKENS = [
  "hello",
  "world",
  "foo",
  "bar",
  "edit",
  "text",
  "line",
  "byte",
  "char",
  "reed",
  "node",
  "tree",
];

/**
 * Generate a line that mixes ASCII, kanji (3 bytes/char), and emoji (4 bytes/char).
 *
 * Token distribution (by rng bucket):
 *   < 0.40 → ASCII word   (1 byte per char)
 *   < 0.70 → kanji word   (3 bytes per char in UTF-8)
 *   ≥ 0.70 → emoji token  (4 bytes per char, surrogate pair in JS)
 */
function multibyteLine(rng: () => number): string {
  const tokenCount = 3 + Math.floor(rng() * 6); // 3–8 tokens
  const tokens: string[] = [];
  for (let i = 0; i < tokenCount; i++) {
    const r = rng();
    if (r < 0.4) {
      tokens.push(ASCII_TOKENS[Math.floor(rng() * ASCII_TOKENS.length)]);
    } else if (r < 0.7) {
      tokens.push(KANJI_WORDS[Math.floor(rng() * KANJI_WORDS.length)]);
    } else {
      tokens.push(EMOJI_POOL[Math.floor(rng() * EMOJI_POOL.length)]);
    }
  }
  return tokens.join(" ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a large string of text with the requested number of lines.
 *
 * @example
 * const content = generateLargeContent({ lineCount: 50_000, pattern: 'code' });
 * const state = createInitialState({ content });
 */
export function generateLargeContent(options: LargeContentOptions = {}): string {
  const { lineCount = 100_000, pattern = "prose", seed = 42, lineEnding = "\n" } = options;

  const rng = makeDeterministicRng(seed);
  const lines: string[] = [];

  if (pattern === "uniform") {
    const line = "The quick brown fox jumps over the lazy dog. Reed editor performance test.";
    for (let i = 0; i < lineCount; i++) lines.push(line);
  } else {
    for (let i = 0; i < lineCount; i++) {
      switch (pattern) {
        case "prose":
          lines.push(proseLine(rng));
          break;
        case "code":
          lines.push(codeLine(rng, i));
          break;
        case "random":
          lines.push(randomLine(rng));
          break;
        case "multibyte":
          lines.push(multibyteLine(rng));
          break;
      }
    }
  }

  return lines.join(lineEnding);
}

/**
 * Approximate byte size of a string when UTF-8 encoded.
 * (Exact for ASCII-only content; use TextEncoder for exact measurement.)
 */
export function approximateByteSize(content: string): number {
  // ASCII fast-path; falls back to encoder for multi-byte
  let size = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c < 0x80) size += 1;
    else if (c < 0x800) size += 2;
    else size += 3;
  }
  return size;
}
