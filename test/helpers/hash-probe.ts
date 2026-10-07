// Prints hashes of a fixed, locale-sensitive sample. Run as a subprocess under different
// TZ/LANG values; every run must print the same line (M1 AC3).
import { hash, normalizeSnippet, stableSort } from "../../src/core/determinism.js";

const words = ["zebra", "Äpfel", "apple", "Zürich", "ångström", "école", "Ωmega", "😀", "ｱ", "á"];
const sample = {
  sorted: stableSort(words, (w) => w),
  snippet: normalizeSnippet("\tconst ß = 'İstanbul';\r\n"),
  nested: { "ß": 1, "ss": 2, "SS": 3, "ǅ": 4 },
  upper: words.map((w) => w.toUpperCase()),
};
process.stdout.write(`${hash(sample)}\n`);
