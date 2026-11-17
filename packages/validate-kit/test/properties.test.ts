import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fileLinks, includeLines } from "../src/adapters/review-md.js";
import { stableJson } from "../src/core/evidence.js";
import { groupBy } from "../src/core/group.js";

// Properties: statements that hold for every input, checked on generated
// ones (fast-check). A failure prints the smallest input that breaks one;
// keep that input as an `examples` entry of its `fc.assert`.

/** The same JSON value with every object's keys in reverse insertion order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, inner]) => [key, reversed(inner)]),
  );
}

describe("stableJson: the text the config digest is taken from", () => {
  it("does not depend on the order keys were written in", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(stableJson(reversed(value))).toBe(stableJson(value));
      }),
    );
  });

  it("reads back as what JSON.stringify writes", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(JSON.parse(stableJson(value))).toEqual(
          JSON.parse(JSON.stringify(value)),
        );
      }),
    );
  });
});

const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}\.md$/);
const prose = fc.stringMatching(/^[A-Za-z][A-Za-z ,.]{0,40}$/);
/** A piece of Markdown, and whether it is a link to a repository file. */
const piece = fc.oneof(
  name.map((file) => ({ file: true, text: `[rule](docs/${file})` })),
  fc.webUrl().map((url) => ({ file: false, text: `[site](${url})` })),
  name.map((file) => ({ file: false, text: `[top](#${file})` })),
  prose.map((text) => ({ file: false, text })),
);

describe("review-md: reading a REVIEW.md", () => {
  it("prose between the lines moves an include, and never adds or loses one", () => {
    fc.assert(
      fc.property(
        fc.array(name),
        fc.array(prose),
        fc.infiniteStream(fc.nat()),
        (names, words, places) => {
          const lines = names.map((file) => `@${file}`);
          for (const word of words)
            lines.splice(places.next().value % (lines.length + 1), 0, word);
          const { includes, spaced } = includeLines(lines.join("\n"));
          expect(includes.map((include) => include.target)).toEqual(names);
          expect(includes.every((include) => !include.fenced)).toBe(true);
          expect(includes.map((include) => lines[include.line - 1])).toEqual(
            names.map((file) => `@${file}`),
          );
          expect(spaced).toEqual([]);
        },
      ),
    );
  });

  it("inside a code fence every include is marked, and after it none is", () => {
    fc.assert(
      fc.property(
        fc.array(name, { minLength: 1 }),
        fc.constantFrom("```", "~~~~"),
        (names, fence) => {
          const inside = names.map((file) => `@${file}`).join("\n");
          const { includes } = includeLines(
            `${fence}markdown\n${inside}\n${fence}\n${inside}`,
          );
          expect(includes.map((include) => include.fenced)).toEqual([
            ...names.map(() => true),
            ...names.map(() => false),
          ]);
        },
      ),
    );
  });

  it("counts the links to repository files, and no web link, anchor or word", () => {
    fc.assert(
      fc.property(fc.array(piece), (pieces) => {
        expect(fileLinks(pieces.map((part) => part.text).join("\n"))).toBe(
          pieces.filter((part) => part.file).length,
        );
      }),
    );
  });
});

// The four kinds of property the verification write-up names: a round trip
// and an invariant are above; these are the other two.
describe("idempotency and equivalence", () => {
  it("stableJson applied to its own output changes nothing (idempotency)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = stableJson(value);
        expect(stableJson(JSON.parse(once))).toBe(once);
      }),
    );
  });

  it("groupBy gives what the plain two-loop version gives (equivalence)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ key: fc.integer({ min: 0, max: 5 }), id: fc.nat() }),
        ),
        (items) => {
          // Naive and correct: each key in first-seen order, then its items in order.
          const keys = items
            .map((item) => item.key)
            .filter((key, index, all) => all.indexOf(key) === index);
          const naive = keys.map((key) => [
            key,
            items.filter((item) => item.key === key),
          ]);
          expect([...groupBy(items, (item) => item.key)]).toEqual(naive);
        },
      ),
    );
  });
});
