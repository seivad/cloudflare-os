// What of a chat message is read aloud, and in what pieces. Pure, so it is tested on its own.

/**
 * The part of a Markdown message worth hearing: prose, with code blocks, inline-HTML blocks,
 * images, link targets, tables' rules and Markdown punctuation taken out. A code block becomes a
 * short spoken note, since reading code aloud helps nobody.
 */
export function spokenText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " (code shown on screen) ")
    .replace(/<inline-html>[\s\S]*?(<\/inline-html>|$)/gi, " ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * `text` in pieces to speak one after another: whole sentences, the first piece short so the
 * first words are heard soon, the rest up to `max` characters. A sentence longer than a piece is
 * cut at a space.
 */
export function speechChunks(text: string, firstMax = 220, max = 1200): string[] {
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const chunks: string[] = [];
  let current = "";
  const limit = () => (chunks.length === 0 ? firstMax : max);
  const push = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (let sentence of sentences) {
    while (sentence.length > limit()) {
      push();
      const cut = sentence.lastIndexOf(" ", limit());
      const at = cut > limit() / 2 ? cut : limit();
      chunks.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at).trim();
    }
    if (current && current.length + 1 + sentence.length > limit()) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return chunks;
}
