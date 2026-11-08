/**
 * @fileoverview Dice-coefficient trigram similarity — the near-match scorer
 * behind both company-name suggestions and concept-name suggestions. A leaf
 * module so the static concept catalog can score names without importing the
 * HTTP service.
 * @module services/edgar/trigram-similarity
 */

/**
 * Build the set of trigrams for a string.
 * Pads with two spaces on each side so edge characters are covered; every
 * string, the empty one included, therefore has at least one trigram.
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
 * A scorer of strings against `a`, whose trigram set is built once, here: each
 * call builds only the set of the string it scores, so a pass ranking a list
 * against one input uses one scorer. Each call returns the Dice coefficient in
 * [0, 1]; 1 means identical.
 */
export function trigramScorer(a: string): (b: string) => number {
  const ga = trigramSet(a);
  return (b) => {
    if (a === b) return 1;
    const gb = trigramSet(b);
    let intersection = 0;
    for (const g of gb) {
      if (ga.has(g)) intersection++;
    }
    return (2 * intersection) / (ga.size + gb.size);
  };
}
