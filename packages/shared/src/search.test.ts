import { findSearchRanges } from "./search";

describe("document search", () => {
  it("matches punctuation exactly without width normalization", () => {
    const text = "alpha, beta，gamma, delta";

    expect(findSearchRanges(text, ",")).toEqual([
      { from: 5, to: 6 },
      { from: 17, to: 18 }
    ]);
    expect(findSearchRanges(text, "，")).toEqual([{ from: 11, to: 12 }]);
  });

  it("supports case-sensitive matching", () => {
    const text = "Alpha alpha ALPHA";

    expect(findSearchRanges(text, "alpha")).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 }
    ]);
    expect(findSearchRanges(text, "alpha", { caseSensitive: true })).toEqual([{ from: 6, to: 11 }]);
  });

  it("keeps original offsets when case folding changes string length", () => {
    expect(findSearchRanges("İ, exact", ",")).toEqual([{ from: 1, to: 2 }]);
  });

  it("maps case-insensitive matches back across length-changing case folds", () => {
    expect(findSearchRanges("İstanbul.md", "i")).toEqual([{ from: 0, to: 1 }]);
    expect(findSearchRanges("İ ΟΣ", "ος")).toEqual([{ from: 2, to: 4 }]);
    expect(findSearchRanges("Straße.md", "STRASSE")).toEqual([{ from: 0, to: 6 }]);
  });

  it("stops collecting ranges once the match limit is reached", () => {
    expect(findSearchRanges("alpha beta alpha gamma alpha", "alpha", { maxMatches: 2 })).toEqual([
      { from: 0, to: 5 },
      { from: 11, to: 16 }
    ]);
  });
});
