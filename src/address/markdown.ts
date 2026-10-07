// Markdown helpers for Address outputs. Tool-supplied text (messages, paths, rule ids) is
// ESCAPED: it flows into pandoc → Typst, where unescaped `*`, `_`, `#`, `<`, or `|` would
// change the document's structure.

// Only what pandoc interprets INLINE: emphasis/code/links/raw HTML/tables, math ($),
// citations (@), strikeout/sub/superscript (~ ^), and backslash itself.
const SPECIAL = /[\\`*_[\]<>|$@~^]/g;

export function esc(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(SPECIAL, (c) => `\\${c}`);
}

/** Inline code span that can't be broken out of (picks a fence longer than any backtick run). */
export function code(s: string): string {
  const flat = s.replace(/\r?\n/g, " ");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/**
 * Pipe table. `widths` (relative, e.g. [6, 8, 40]) become separator dash counts: pandoc sizes
 * columns proportionally to them when cells are long, which keeps wide tables readable in the PDF.
 */
export function table(header: readonly string[], rows: readonly (readonly string[])[], widths?: readonly number[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  const sep = header.map((_, i) => "-".repeat(Math.max(3, widths?.[i] ?? 3)));
  return [line(header), line(sep), ...rows.map(line)].join("\n");
}

const KEEP_START = /^<!-- radr:keep id=([a-z0-9-]+) -->$/;
const KEEP_END = "<!-- radr:end -->";

/** Consultant-owned block: radr writes the default once, then preserves whatever is there. */
export function keep(id: string, defaultBody: string): string {
  return `<!-- radr:keep id=${id} -->\n${defaultBody}\n${KEEP_END}`;
}

/** Extract keep-blocks from a previously generated document. */
export function extractKeeps(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = KEEP_START.exec(lines[i] ?? "");
    if (m?.[1] === undefined) continue;
    const end = lines.indexOf(KEEP_END, i + 1);
    if (end === -1) continue;
    out.set(m[1], lines.slice(i + 1, end).join("\n"));
    i = end;
  }
  return out;
}

/**
 * Replace each keep-block's body in `generated` with the preserved body. Blocks whose id no
 * longer exists in the template are appended under "Preserved notes", never dropped.
 */
export function applyKeeps(generated: string, preserved: ReadonlyMap<string, string>): string {
  const used = new Set<string>();
  const lines = generated.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = KEEP_START.exec(line);
    const id = m?.[1];
    const end = id === undefined ? -1 : lines.indexOf(KEEP_END, i + 1);
    if (id === undefined || end === -1 || !preserved.has(id)) {
      out.push(line);
      continue;
    }
    out.push(line, preserved.get(id) ?? "", KEEP_END);
    used.add(id);
    i = end;
  }
  const orphans = [...preserved.keys()].filter((k) => !used.has(k)).sort();
  if (orphans.length > 0) {
    out.push("", "## Preserved notes", "");
    for (const k of orphans) out.push(keep(k, preserved.get(k) ?? ""), "");
  }
  return out.join("\n");
}
