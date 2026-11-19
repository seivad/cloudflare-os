import { describe, expect, it } from "vitest";
import {
  buildProjectFiles,
  hasProjectCode,
  PROJECT_EXPORT_ID,
  projectArchive,
  projectExportFormat,
  projectSlug,
  type ProjectInput,
  type ProjectRuntime,
  withProjectFormat,
  zipTextFiles,
} from "../src/project-export";
import { validateExportFormats } from "../src/gadget-export";

const RUNTIME: ProjectRuntime = {
  worker: "// worker runtime\n",
  page: "// page runtime\n",
  capnwebBrowser: "// capnweb for browsers\n",
  capnwebWorkers: "// capnweb for Workers\n",
  capnwebVersion: "9.9.9",
  capnwebLicense: "MIT License\n",
};

const SERVER = `import { DurableObject } from "cloudflare:workers";\nexport class Gadget extends DurableObject {}\n`;

function input(over: Partial<ProjectInput> = {}): ProjectInput {
  return {
    title: "Team Notes",
    files: new Map([["server.js", SERVER], ["client.js", "document.body.append('hi');\n"], ["lib/words.js", "export const a = 1;\n"], ["README.md", "# Notes\n"]]),
    bindings: [],
    ...over,
  };
}

/** A ZIP's entries, read from its central directory and inflated: what an unzip tool sees. */
async function unzip(bytes: Uint8Array): Promise<Map<string, string>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // The local header says the same as the central one, so a tool reading either agrees.
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 18, true)).toBe(packedSize);
    expect(view.getUint32(local + 22, true)).toBe(size);
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    expect(method).toBe(8);
    const inflated = new Blob([bytes.subarray(dataAt, dataAt + packedSize)]).stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
    const text = await new Response(inflated).text();
    expect(new TextEncoder().encode(text).byteLength).toBe(size);
    entries.set(name, text);
    at += 46 + nameLength;
  }
  return entries;
}

describe("the project export format", () => {
  it("is a server-mode ZIP the Workshop's own validation accepts", () => {
    expect(validateExportFormats([projectExportFormat()])).toEqual([{
      id: PROJECT_EXPORT_ID, label: "Cloudflare Worker project", mode: "server",
      contentType: "application/zip", fileExtension: ".zip",
    }]);
  });

  it("is listed last, in place of a gadget's own format with its id", () => {
    const html = {id: "html", label: "HTML", mode: "browser" as const, contentType: "text/html", fileExtension: ".html"};
    const impostor = {...projectExportFormat(), label: "Not the project"};
    expect(withProjectFormat([impostor, html]).map(f => [f.id, f.label])).toEqual([
      ["html", "HTML"], [PROJECT_EXPORT_ID, "Cloudflare Worker project"],
    ]);
    expect(withProjectFormat([])).toEqual([projectExportFormat()]);
  });

  it("is offered only for a gadget with code", () => {
    expect(hasProjectCode(new Map([["server.js", ""]]))).toBe(true);
    expect(hasProjectCode(new Map([["client.js", ""]]))).toBe(true);
    expect(hasProjectCode(new Map([["README.md", ""]]))).toBe(false);
    expect(hasProjectCode(new Map())).toBe(false);
  });
});

describe("a gadget's project", () => {
  it("names the Worker after the gadget, in characters a Worker name takes", () => {
    expect(projectSlug("Team Notes")).toBe("team-notes");
    expect(projectSlug("  Naïve Café — 2026!  ")).toBe("naive-cafe-2026");
    expect(projectSlug("…")).toBe("gadget");
    expect(projectSlug("x".repeat(200))).toHaveLength(54);
    for (const title of ["a/b", "../../etc", "UPPER lower", "x".repeat(200)]) {
      expect(projectSlug(title)).toMatch(/^[a-z0-9]([a-z0-9-]{0,52}[a-z0-9])?$/);
    }
  });

  it("holds the gadget's files untouched, in one directory with what runs them", () => {
    const files = buildProjectFiles(input(), RUNTIME);
    expect([...files.keys()].toSorted()).toEqual([
      "team-notes/.gitignore",
      "team-notes/LICENSE-capnweb.txt",
      "team-notes/README.md",
      "team-notes/package.json",
      "team-notes/public/capnweb.js",
      "team-notes/public/client.js",
      "team-notes/public/index.html",
      "team-notes/public/runtime.js",
      "team-notes/src/gadget/README.md",
      "team-notes/src/gadget/lib/words.js",
      "team-notes/src/gadget/server.js",
      "team-notes/src/project.js",
      "team-notes/src/vendor/capnweb.js",
      "team-notes/src/worker.js",
      "team-notes/wrangler.jsonc",
    ]);
    expect(files.get("team-notes/src/gadget/server.js")).toBe(SERVER);
    expect(files.get("team-notes/public/client.js")).toBe("document.body.append('hi');\n");
    expect(files.get("team-notes/src/worker.js")).toBe(RUNTIME.worker);
    expect(files.get("team-notes/public/runtime.js")).toBe(RUNTIME.page);
    expect(files.get("team-notes/src/vendor/capnweb.js")).toBe(RUNTIME.capnwebWorkers);
    expect(files.get("team-notes/public/capnweb.js")).toBe(RUNTIME.capnwebBrowser);
  });

  it("configures a Worker with the gadget's Durable Object on SQLite storage and its page as assets", () => {
    const files = buildProjectFiles(input(), RUNTIME);
    const text = files.get("team-notes/wrangler.jsonc")!;
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
    expect(config).toEqual({
      $schema: "node_modules/wrangler/config-schema.json",
      name: "team-notes",
      main: "src/worker.js",
      compatibility_date: "2026-02-01",
      assets: {directory: "./public"},
      durable_objects: {bindings: [{name: "GADGET_OBJECT", class_name: "Gadget"}]},
      migrations: [{tag: "v1", new_sqlite_classes: ["Gadget"]}],
      observability: {enabled: true},
    });
    expect(JSON.parse(files.get("team-notes/package.json")!)).toMatchObject({
      name: "team-notes", type: "module", devDependencies: {wrangler: "^4"},
    });
  });

  it("serves a page that loads the runtime before the gadget's code, and reaches only itself", () => {
    const html = buildProjectFiles(input({title: `Notes <script>alert("x")</script>`}), RUNTIME)
        .get("notes-script-alert-x-script/public/index.html")!;
    expect(html).toContain("<title>Notes &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</title>");
    expect(html.indexOf('src="/runtime.js"')).toBeLessThan(html.indexOf('src="/client.js"'));
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'self'");
  });

  it("names each binding, carries none, and maps a language model to Workers AI", () => {
    const files = buildProjectFiles(input({
      bindings: [
        {name: "MODEL", title: "Claude Sonnet", kind: "aiModel"},
        {name: "REPO", title: "acme/widgets | main", kind: "gatekeeper", vendorId: "github"},
        {name: "LIBRARY", title: "Context Library", kind: "ambient"},
      ],
    }), RUNTIME);
    const project = files.get("team-notes/src/project.js")!;
    expect(JSON.parse(project.slice(project.indexOf("{"), project.lastIndexOf("}") + 1))).toEqual({
      title: "Team Notes",
      slug: "team-notes",
      bindings: [
        {name: "MODEL", title: "Claude Sonnet", kind: "aiModel"},
        {name: "REPO", title: "acme/widgets | main", kind: "gatekeeper"},
        {name: "LIBRARY", title: "Context Library", kind: "ambient"},
      ],
    });
    const config = JSON.parse(files.get("team-notes/wrangler.jsonc")!.replace(/^\s*\/\/.*$/gm, ""));
    expect(config.ai).toEqual({binding: "AI"});
    expect(config.vars).toEqual({AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"});
    const readme = files.get("team-notes/README.md")!;
    expect(readme).toContain("| `MODEL` | Claude Sonnet | Works, with a model of yours");
    // A title cannot break the table it is written into.
    expect(readme).toContain("| `REPO` | acme/widgets \\| main | A connection approved in the Workshop (`github`)");
    expect(readme).toContain("**Nothing in this project signs anyone in.**");
    // No AI binding where the gadget had no model.
    const plain = JSON.parse(buildProjectFiles(input(), RUNTIME).get("team-notes/wrangler.jsonc")!.replace(/^\s*\/\/.*$/gm, ""));
    expect(plain.ai).toBeUndefined();
    expect(buildProjectFiles(input(), RUNTIME).get("team-notes/README.md")).toContain("had no connections");
  });

  it("stands a file in for a missing server or page, and keeps unsafe paths out", () => {
    const pageOnly = buildProjectFiles(input({files: new Map([["client.js", "1;\n"]])}), RUNTIME);
    expect(pageOnly.get("team-notes/src/gadget/server.js")).toContain("export class Gadget extends DurableObject {}");
    const serverOnly = buildProjectFiles(input({files: new Map([["server.js", SERVER]])}), RUNTIME);
    expect(serverOnly.get("team-notes/public/client.js")).toContain("This gadget has no page.");
    const odd = buildProjectFiles(input({
      files: new Map([["server.js", SERVER], ["../escape.js", "x"], ["a//b.js", "x"], ["a\\b.js", "x"], ["./c.js", "x"], ["ok/d.js", "x"]]),
    }), RUNTIME);
    expect([...odd.keys()].filter(path => path.includes("src/gadget/")).toSorted()).toEqual([
      "team-notes/src/gadget/ok/d.js", "team-notes/src/gadget/server.js",
    ]);
    for (const path of odd.keys()) expect(path.split("/")).not.toContain("..");
  });
});

describe("the project archive", () => {
  it("zips text files so that each comes back as it went in", async () => {
    const files = new Map([
      ["dir/a.txt", "hello\n"],
      ["dir/ünïcode ☃.md", "snow ☃ ".repeat(5000)],
      ["empty.js", ""],
    ]);
    const archive = await zipTextFiles(files);
    expect(await unzip(archive)).toEqual(files);
    // Repetitive text is stored deflated, not as it is.
    expect(archive.byteLength).toBeLessThan(5000);
  });

  it("is the whole project, with the runtime the build generated", async () => {
    const stream = await projectArchive(input({bindings: [{name: "MODEL", title: "A model", kind: "aiModel"}]}));
    const entries = await unzip(new Uint8Array(await new Response(stream).arrayBuffer()));
    expect(entries.get("team-notes/src/gadget/server.js")).toBe(SERVER);
    // The real runtime: the Worker that bridges the page to the object, and Cap'n Web for both sides.
    expect(entries.get("team-notes/src/worker.js")).toContain("newWorkersRpcResponse");
    expect(entries.get("team-notes/public/runtime.js")).toContain("newWebSocketRpcSession");
    expect(entries.get("team-notes/src/vendor/capnweb.js")).toContain(`from "cloudflare:workers"`);
    expect(entries.get("team-notes/public/capnweb.js")).not.toContain(`from "cloudflare:workers"`);
    expect(entries.get("team-notes/LICENSE-capnweb.txt")).toContain("MIT License");
    expect(entries.get("team-notes/README.md")).toMatch(/Cap'n Web\]\(https:\/\/github\.com\/cloudflare\/capnweb\) \d+\.\d+\.\d+/);
  });
});
