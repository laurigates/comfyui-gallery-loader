// modal-fuzzy.test.js — coverage for fuzzyScore + fuzzyRank.
//
// highlightMatches is deferred: it returns a DocumentFragment and requires a
// DOM. Vitest's default `node` environment has no DOM. Switching to `jsdom`
// would add a heavyweight dev dependency for one helper; revisit if we later
// pull modal-shell DOM helpers under coverage.

import { describe, expect, test } from "vitest";

import { fuzzyRank, fuzzyScore } from "../../web/js/modal-fuzzy.js";

describe("fuzzyScore", () => {
  test("empty query returns zero score and no matches", () => {
    expect(fuzzyScore("", "anything")).toEqual({ score: 0, matches: [] });
  });

  test("null target returns null when query is non-empty", () => {
    expect(fuzzyScore("x", "")).toBeNull();
  });

  test("returns null when query is not a subsequence of target", () => {
    expect(fuzzyScore("xyz", "abc")).toBeNull();
  });

  test("matches indices in target order", () => {
    const result = fuzzyScore("ace", "abcde");
    expect(result).not.toBeNull();
    expect(result.matches).toEqual([0, 2, 4]);
  });

  test("start-of-string bonus is bigger than mid-string match", () => {
    // 'a' at position 0 gets base 1 + start bonus 5 = 6
    // 'a' at position 1 gets only base 1
    const head = fuzzyScore("a", "abc");
    const mid = fuzzyScore("a", "bac");
    expect(head).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(head.score).toBeGreaterThan(mid.score);
  });

  test("separator bonus applies after underscore", () => {
    // 'b' at index 4 of 'foo_bar' is after '_' separator → +4 bonus.
    // Compared with mid-string 'b' (no separator), the separator hit wins.
    const sep = fuzzyScore("b", "foo_bar");
    const plain = fuzzyScore("b", "fooobar");
    expect(sep).not.toBeNull();
    expect(plain).not.toBeNull();
    expect(sep.score).toBeGreaterThan(plain.score);
  });

  test("separator bonus applies after dash, space, dot, and slash", () => {
    const plain = fuzzyScore("b", "fooobar");
    for (const target of ["foo-bar", "foo bar", "foo.bar", "foo/bar"]) {
      const result = fuzzyScore("b", target);
      expect(result).not.toBeNull();
      expect(result.score).toBeGreaterThan(plain.score);
    }
  });

  test("CamelCase boundary bonus applies on lower→upper transition", () => {
    // 'B' at index 3 of 'fooBar' has lowercase predecessor in original
    // casing → +3 boundary bonus.
    const camel = fuzzyScore("b", "fooBar");
    const flat = fuzzyScore("b", "foobar");
    expect(camel).not.toBeNull();
    expect(flat).not.toBeNull();
    expect(camel.score).toBeGreaterThan(flat.score);
  });

  test("consecutive cluster earns escalating bonus", () => {
    // 'abc' on 'abc' (cluster of 3) outscores 'abc' on 'a_b_c' (separators).
    // Consecutive escalation per char: +2, +4, +6 vs separator bonus of +4.
    const cluster = fuzzyScore("abc", "abcxx");
    const spread = fuzzyScore("abc", "a_b_c");
    expect(cluster).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(cluster.score).toBeGreaterThan(spread.score);
  });

  test("tie-break favors shorter targets", () => {
    const short = fuzzyScore("a", "a");
    const long = fuzzyScore("a", `a${"x".repeat(50)}`);
    expect(short).not.toBeNull();
    expect(long).not.toBeNull();
    expect(short.score).toBeGreaterThan(long.score);
  });

  test("matching is case-insensitive but CamelCase boundary uses original casing", () => {
    // 'B' uppercase in target is still matched by lowercase 'b' in query.
    const result = fuzzyScore("b", "fooBar");
    expect(result).not.toBeNull();
    expect(result.matches).toEqual([3]);
  });
});

describe("fuzzyRank", () => {
  test("empty query returns zero score and no primary matches", () => {
    expect(fuzzyRank("", ["foo"])).toEqual({ score: 0, primaryMatches: [] });
  });

  test("whitespace-only query short-circuits to zero", () => {
    expect(fuzzyRank("   ", ["foo"])).toEqual({ score: 0, primaryMatches: [] });
  });

  test("returns null when any token fails to match any field", () => {
    expect(fuzzyRank("foo zzz", ["foobar", "foobaz"])).toBeNull();
  });

  test("primary field is weighted heavier than secondary fields", () => {
    // Same fuzzy score on primary vs secondary — primary wins via weight.
    const onPrimary = fuzzyRank("foo", ["foobar", "baz"]);
    const onSecondary = fuzzyRank("foo", ["baz", "foobar"]);
    expect(onPrimary).not.toBeNull();
    expect(onSecondary).not.toBeNull();
    expect(onPrimary.score).toBeGreaterThan(onSecondary.score);
  });

  test("AND-token semantics: every whitespace-separated token must match", () => {
    // Both tokens match somewhere → not null.
    const both = fuzzyRank("foo bar", ["foobar"]);
    expect(both).not.toBeNull();

    // 'foo' matches, 'xyz' does not → null overall.
    const partial = fuzzyRank("foo xyz", ["foobar"]);
    expect(partial).toBeNull();
  });

  test("tokens can match across different fields", () => {
    const result = fuzzyRank("foo bar", ["foozz", "barzz"]);
    expect(result).not.toBeNull();
  });

  test("primaryMatches deduplicates and sorts indices from multiple tokens", () => {
    // 'fo' and 'oo' both match the primary at overlapping/duplicated indices.
    // Expect sorted ascending order with no duplicates.
    const result = fuzzyRank("fo oo", ["foobar"]);
    expect(result).not.toBeNull();
    expect(result.primaryMatches).toEqual([...result.primaryMatches].sort((a, b) => a - b));
    expect(result.primaryMatches.length).toBe(new Set(result.primaryMatches).size);
  });

  test("primaryMatches only collects indices from tokens that landed on primary", () => {
    // 'foo' on primary 'foobar' lands at indices 0,1,2.
    // 'baz' only matches the secondary field → not included in primaryMatches.
    const result = fuzzyRank("foo baz", ["foobar", "bazquux"]);
    expect(result).not.toBeNull();
    // Indices 0,1,2 from 'foo' on primary; none from 'baz'.
    expect(result.primaryMatches).toEqual([0, 1, 2]);
  });

  test("falsy secondary fields are skipped without erroring", () => {
    const result = fuzzyRank("foo", ["foobar", null, undefined, ""]);
    expect(result).not.toBeNull();
  });

  test("custom primaryWeight changes ranking magnitude", () => {
    const baseScore = fuzzyRank("foo", ["foobar"]).score;
    const doubled = fuzzyRank("foo", ["foobar"], 20).score;
    expect(doubled).toBeGreaterThan(baseScore);
  });
});
