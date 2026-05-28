// modal-fuzzy.js — fzf-lite-style fuzzy matcher for picker rows.
//
// Greedy left-to-right subsequence with scoring bonuses for matches at
// start-of-string and after separators (_/-/space/dot/slash/CamelCase
// boundaries). Consecutive matches earn an escalating bonus (clusters win).
// AND-token semantics: a space in the query splits into tokens; every
// token must match somewhere on the row.
//
// Lifted from comfyui-sampler-info (same authorship) and namespaced for
// the modal lib. Self-contained — no other imports. Suitable for extraction
// alongside modal-shell.js into a shared frontend-only pack.

/**
 * Score a single token against a target string.
 *
 * @param {string} query    Lowercased token, no spaces.
 * @param {string} target   Raw target string (case-insensitive matched, but
 *                          CamelCase boundaries in the original casing
 *                          earn a bonus).
 * @returns {{score: number, matches: number[]} | null}
 *          null if the query is not a subsequence of target; otherwise the
 *          score and the indices (into `target`) where matches landed.
 */
export function fuzzyScore(query, target) {
  if (!query) return { score: 0, matches: [] };
  if (!target) return null;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const matches = [];
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let prevMatchIdx = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      consecutive = 0;
      continue;
    }
    let charScore = 1;
    if (ti === 0) {
      charScore += 5;
    } else {
      const prev = t[ti - 1];
      if (prev === "_" || prev === "-" || prev === " " || prev === "." || prev === "/") {
        charScore += 4;
      } else if (prev >= "a" && prev <= "z" && target[ti] >= "A" && target[ti] <= "Z") {
        charScore += 3;
      }
    }
    if (ti === prevMatchIdx + 1) {
      consecutive++;
      charScore += consecutive * 2;
    } else {
      consecutive = 0;
    }
    score += charScore;
    matches.push(ti);
    prevMatchIdx = ti;
    qi++;
  }

  if (qi < q.length) return null;
  // Tie-break: shorter targets win.
  score -= target.length * 0.01;
  return { score, matches };
}

/**
 * Rank a candidate row against a query across multiple fields.
 *
 * Splits the query on whitespace into AND-tokens. Each token must match at
 * least one field. The first field is the "primary" (e.g. the displayed
 * name) and its match score is weighted `primaryWeight` × heavier than the
 * other fields, so a hit on the name beats a hit on the summary.
 *
 * @param {string} query
 * @param {(string | null | undefined)[]} fields  First field is primary.
 * @param {number} [primaryWeight=10]
 * @returns {{score: number, primaryMatches: number[]} | null}
 */
export function fuzzyRank(query, fields, primaryWeight = 10) {
  if (!query) return { score: 0, primaryMatches: [] };
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { score: 0, primaryMatches: [] };

  const primary = fields[0] || "";
  const rest = fields.slice(1).filter(Boolean);

  let totalScore = 0;
  const primaryMatchSet = new Set();

  for (const token of tokens) {
    const primaryResult = fuzzyScore(token, primary);
    let best = primaryResult
      ? {
          score: primaryResult.score * primaryWeight,
          matches: primaryResult.matches,
          onPrimary: true,
        }
      : null;
    for (const field of rest) {
      const r = fuzzyScore(token, field);
      if (r && (!best || r.score > best.score)) {
        best = { score: r.score, matches: r.matches, onPrimary: false };
      }
    }
    if (!best) return null;
    totalScore += best.score;
    if (best.onPrimary) {
      for (const i of best.matches) primaryMatchSet.add(i);
    }
  }

  return {
    score: totalScore,
    primaryMatches: [...primaryMatchSet].sort((a, b) => a - b),
  };
}

/**
 * Wrap matched characters in `target` with <span class="cmp-match">…</span>,
 * leaving the rest as escaped text. Returns a DocumentFragment ready to
 * append. Use the match indices from fuzzyScore/fuzzyRank.
 *
 * @param {string} target
 * @param {number[]} matchIndices
 * @returns {DocumentFragment}
 */
export function highlightMatches(target, matchIndices) {
  const frag = document.createDocumentFragment();
  if (!target) return frag;
  const set = new Set(matchIndices || []);
  if (!set.size) {
    frag.appendChild(document.createTextNode(target));
    return frag;
  }
  for (let i = 0; i < target.length; i++) {
    if (set.has(i)) {
      const m = document.createElement("span");
      m.className = "cmp-match";
      m.textContent = target[i];
      frag.appendChild(m);
    } else {
      frag.appendChild(document.createTextNode(target[i]));
    }
  }
  return frag;
}
