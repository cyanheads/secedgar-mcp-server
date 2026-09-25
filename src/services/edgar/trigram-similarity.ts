/**
 * @fileoverview Dice-coefficient trigram similarity — the near-match scorer
 * behind both company-name suggestions and concept-name suggestions. A leaf
 * module so the static concept catalog can score names without importing the
 * HTTP service.
 * @module services/edgar/trigram-similarity
 */

/**
 * Build the set of trigrams for a string.
 * Pads with two spaces on each side so edge characters are covered.
 */
function trigramSet(s: string): Set<string> {
  const padded = `  ${s}  `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/**
 * Dice-coefficient trigram similarity between two strings.
 * Returns a value in [0, 1]; 1 means identical.
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ga = trigramSet(a);
  const gb = trigramSet(b);
  if (ga.size === 0 && gb.size === 0) return 1;
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  for (const g of ga) {
    if (gb.has(g)) intersection++;
  }
  return (2 * intersection) / (ga.size + gb.size);
}
