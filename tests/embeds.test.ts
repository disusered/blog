import assert from "node:assert/strict";
import test from "node:test";
import { embedFor } from "../src/embeds.ts";
import { renderWriting } from "../src/publication.ts";

const site = "https://writer.example";
const demo = "https://writer.example/demos/phaser/hello-world/";

test("a bare allowlisted URL renders as a sandboxed iframe and stays a URL in text", async () => {
  for (const body of [`${demo}\n`, `<${demo}>\n`, `[${demo}](${demo})\n`]) {
    const source = `Before.\n\n${body}\nAfter.`;
    const { html, text } = await renderWriting(source, site);
    assert.match(
      html,
      new RegExp(
        `<figure class="embed"><iframe src="${demo}" title="${demo}" sandbox="allow-scripts allow-same-origin allow-modals" loading="lazy"`,
      ),
    );
    assert.match(html, new RegExp(`<figcaption><a href="${demo}">${demo}</a>`));
    assert.doesNotMatch(html, /<p><a/);
    // Plain text matches what the same URL gives when it is not embedded.
    assert.equal(
      text,
      (await renderWriting(source, "https://other.example")).text,
    );
    assert.match(text, new RegExp(`^Before\\.\\s+${demo}\\s+After\\.$`));
  }
});

test("other URLs, mixed paragraphs, and renamed links stay ordinary links", async () => {
  for (const body of [
    "https://example.org/page",
    `See ${demo}`,
    `[the demo](${demo})`,
    `http://writer.example/demos/phaser/hello-world/`,
    "https://codepen.io/someone",
  ]) {
    const { html } = await renderWriting(body, site);
    assert.doesNotMatch(html, /iframe/, body);
    assert.match(html, /<p>.*<a href=/, body);
  }
});

test("third-party hosts embed through their frame URLs without our origin", () => {
  const youtube = {
    src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    sandbox: "allow-scripts allow-same-origin allow-presentation",
  };
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ])
    assert.deepEqual(embedFor(url, { site }), youtube);
  assert.deepEqual(
    embedFor("https://codepen.io/someone/pen/abcDEF", { site }),
    {
      src: "https://codepen.io/someone/embed/abcDEF?default-tab=result",
      sandbox: "allow-scripts allow-presentation",
    },
  );
  assert.equal(
    embedFor("https://www.youtube.com/@channel", { site }),
    undefined,
  );
  assert.equal(embedFor("https://evil.example/embed", { site }), undefined);
  assert.equal(embedFor("https://writer.example.evil/x", { site }), undefined);
});
