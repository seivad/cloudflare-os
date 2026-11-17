import { describe, expect, it } from "vitest";
import { speechChunks, spokenText } from "./speechText";

describe("spokenText", () => {
  it("keeps the prose of a reply and drops what reads badly aloud", () => {
    const reply = [
      "## Done",
      "I've **booked** the meeting for _Thursday_. See [the invite](https://example.com/x).",
      "",
      "```js",
      "const x = 1;",
      "```",
      "- First item",
      "1. Second item",
      "Run `npm test` or visit https://example.com.",
      "<inline-html><button>Hi</button></inline-html>",
    ].join("\n");
    expect(spokenText(reply)).toBe([
      "Done",
      "I've booked the meeting for Thursday. See the invite.",
      "(code shown on screen)",
      "First item",
      "Second item",
      "Run npm test or visit a link",
    ].join("\n"));
  });
});

describe("speechChunks", () => {
  it("keeps sentences whole, with a short first piece so speech starts soon", () => {
    const text = "One two three. " + "Four five six seven. ".repeat(30);
    const chunks = speechChunks(text, 40, 200);
    expect(chunks[0]).toBe("One two three. Four five six seven.");
    for (const chunk of chunks.slice(1)) expect(chunk.length).toBeLessThanOrEqual(200);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.trim().replace(/\s+/g, " "));
  });

  it("cuts a sentence longer than a piece at a space", () => {
    const long = "word ".repeat(100).trim();
    const chunks = speechChunks(long, 50, 120);
    expect(chunks.every((c) => c.length <= 120)).toBe(true);
    expect(chunks.join(" ")).toBe(long);
  });

  it("gives nothing to speak for empty text", () => {
    expect(speechChunks("   ")).toEqual([]);
  });
});
