// A gadget as a Cloudflare Workers project: the files of a directory that `wrangler deploy` turns
// into a Worker of its own, outside the Workshop. The Export menu offers it beside HTML and PDF,
// to whoever may read the gadget's code.
//
// The project is the gadget's own files, untouched, and what the Workshop provided around them:
//
//   src/gadget/**        every file of the gadget but client.js (server.js exports `Gadget`)
//   public/client.js     the gadget's page code
//   src/worker.js        project-runtime/worker.js: serves /api (Cap'n Web to the Durable Object)
//                        and /export, and gives the gadget's code an `env` like the Workshop's
//   public/runtime.js    project-runtime/page.js: the `gadget` stub and the other globals the
//                        Workshop's frame gave client.js
//   wrangler.jsonc       the Worker, its Durable Object (SQLite storage) and its static assets
//
// A gadget's connections (its gatekeeper bindings) do not leave the Workshop: each is a session the
// person approved here. The project names them, stands a stub in for each that fails saying so,
// and its README says what to bind instead.

import type { GadgetExportFormat } from "@gadgets/workshop-shared/api";
import { fileNameSlug, zipFiles } from "@gadgets/workshop-shared/zip";
// The runtime a project carries, as JSON (scripts/build-browser-runtime.ts writes it).
import PROJECT_RUNTIME from "./generated/project-runtime.txt";

/** The export format id of the project archive. A gadget's own format of that id is not listed. */
export const PROJECT_EXPORT_ID = "cloudflare-project";

/** The project archive as the Export menu lists it. */
export function projectExportFormat(): GadgetExportFormat {
  return {
    id: PROJECT_EXPORT_ID,
    label: "Cloudflare Worker project",
    mode: "server",
    contentType: "application/zip",
    fileExtension: ".zip",
  };
}

/** `formats` with the project archive listed last, in place of any format of the gadget's own with its id. */
export function withProjectFormat(formats: readonly GadgetExportFormat[]): GadgetExportFormat[] {
  return [...formats.filter(format => format.id !== PROJECT_EXPORT_ID), projectExportFormat()];
}

/** Whether a gadget's files hold anything a project could run. */
export function hasProjectCode(files: ReadonlyMap<string, string>): boolean {
  return files.has("server.js") || files.has("client.js");
}

/** One of the gadget's bindings, as the project describes it. */
export type ProjectBinding = {
  /** The name in the gadget's `env`. */
  name: string;
  /** What it was connected to, in words for a person. */
  title: string;
  /** What kind of connection it was: a `GatekeeperCreationSpec` type, or "unknown". */
  kind: string;
  /** The gatekeeper that provided it, for a "gatekeeper" binding. */
  vendorId?: string;
};

/** What a project is built from. */
export type ProjectInput = {
  title: string;
  /** The gadget's files by path, as its repository holds them. */
  files: ReadonlyMap<string, string>;
  bindings: readonly ProjectBinding[];
};

/** The code a project carries besides the gadget's own. */
export type ProjectRuntime = {
  /** project-runtime/worker.js */
  worker: string;
  /** project-runtime/page.js */
  page: string;
  /** Cap'n Web as a browser module, and as a Workers module. */
  capnwebBrowser: string;
  capnwebWorkers: string;
  capnwebVersion: string;
  capnwebLicense: string;
};

/** The compatibility date a gadget's Worker is loaded with in the Workshop (overseer.ts, loadGadgetWorker). */
const COMPATIBILITY_DATE = "2026-02-01";

/** The Workers AI model that stands in for a language-model binding, until the project's owner picks another. */
const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const EMPTY_SERVER = `import { DurableObject } from "cloudflare:workers";

// This gadget had no server.js: its page did everything.
export class Gadget extends DurableObject {}
`;

const EMPTY_CLIENT = `// This gadget had no client.js, so there is no page: its Durable Object answers /api only.
document.body.textContent = "This gadget has no page.";
`;

/** A Worker name for `title`: lowercase letters, digits and dashes, at most 54 characters
 * (fileNameSlug()). */
export function projectSlug(title: string): string {
  return fileNameSlug(title);
}

/** Whether a gadget file's path is one a project can hold: relative, with no empty, `.` or `..` part. */
function safePath(path: string): boolean {
  return path.length > 0 && !path.includes("\\") && !path.includes("\0") &&
      path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]!);

/** Markdown table cell text. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function indexHtml(title: string): string {
  // The policy the Workshop's frame had, opened only as far as this Worker itself: the page may
  // load its own scripts and call its own /api, and nothing else on the network.
  const csp = [
    "default-src 'none'",
    "script-src 'self' data: 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src data: 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${csp};">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <!-- runtime.js provides what the Workshop's frame did (the gadget stub above all); client.js is the gadget's page. -->
  <script type="module" src="/runtime.js"></script>
  <script type="module" src="/client.js"></script>
</body>
</html>
`;
}

function wranglerConfig(slug: string, usesAi: boolean): string {
  const config: Record<string, unknown> = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: slug,
    main: "src/worker.js",
    compatibility_date: COMPATIBILITY_DATE,
    assets: {directory: "./public"},
    durable_objects: {bindings: [{name: "GADGET_OBJECT", class_name: "Gadget"}]},
    migrations: [{tag: "v1", new_sqlite_classes: ["Gadget"]}],
    observability: {enabled: true},
    ...(usesAi ? {ai: {binding: "AI"}, vars: {AI_MODEL: DEFAULT_AI_MODEL}} : {}),
  };
  return `// The gadget as a Worker: its code (src/worker.js), its page (public/) and its Durable Object,
// whose storage is the gadget's. Add bindings of your own here (R2, D1, KV, Queues, Workflows,
// Workers AI); the gadget's code reads each as this.env.<NAME>.
${JSON.stringify(config, null, 2)}
`;
}

function bindingAdvice(binding: ProjectBinding): string {
  switch (binding.kind) {
    case "aiModel":
      return "Works, with a model of yours: `run({ prompt, systemPrompt })` goes to Workers AI through the `AI` binding, and `AI_MODEL` in `wrangler.jsonc` names the model. Workers AI runs on Cloudflare and is billed to your account, so `npx wrangler dev` signs in first.";
    case "modelCatalog":
      return "The Workshop's list of models. Not available: name a model in your own code.";
    case "contextLibrary":
      return "The Workshop's Context Library. Not available: keep what the gadget needs in its own storage, or bind R2 or D1.";
    case "agentSpawner":
      return "Started Workshop agents. Not available outside the Workshop.";
    case "gatekeeper":
      return `A connection approved in the Workshop${binding.vendorId ? ` (\`${binding.vendorId}\`)` : ""}. Call that service's own API from \`server.js\` with a credential you keep as a Worker secret.`;
    default:
      return "A Workshop connection. Not available outside the Workshop.";
  }
}

function readme(input: ProjectInput, slug: string, runtime: ProjectRuntime, hadServer: boolean, hadClient: boolean): string {
  const bindings = input.bindings.length === 0
    ? "This gadget had no connections, so nothing is missing.\n"
    : `Each connection the gadget had in the Workshop was a session a person approved there, and none of
them leaves with the code. The gadget still finds each name in \`this.env\`, but a call on one fails
with a message naming it, unless the table says it works. To replace one, add a binding of that name
to \`wrangler.jsonc\`, or change the code that calls it: a binding you add wins over the stand-in.

| \`env\` name | It was | In this project |
|---|---|---|
${input.bindings.map(b => `| \`${cell(b.name)}\` | ${cell(b.title)} | ${bindingAdvice(b)} |`).join("\n")}
`;
  return `# ${input.title}

This is the gadget "${input.title}" as a Cloudflare Workers project of its own: its code, a small
Worker that runs it, and the configuration to deploy it to your Cloudflare account. It was exported
from Cloudflare OS and no longer needs it.

## Run it

You need Node.js 20 or later and, to deploy, a Cloudflare account (the free plan is enough: the
gadget's Durable Object uses SQLite storage).

\`\`\`sh
npm install          # installs Wrangler, the only dependency
npx wrangler dev     # runs it on http://localhost:8787
npx wrangler deploy  # deploys it to https://${slug}.<your-subdomain>.workers.dev
\`\`\`

## Before you share the address

**Nothing in this project signs anyone in.** In the Workshop, only people you shared the workspace
with could open the gadget. Deployed like this, anyone who has the address can open the page and
call every method of the gadget. Unless that is what you want, put Cloudflare Access in front of
it: in the Cloudflare dashboard open **Workers & Pages**, select this Worker, go to **Settings** >
**Domains & Routes**, and choose **Enable Cloudflare Access** for its \`workers.dev\` address. Then
say who may sign in under **Manage Cloudflare Access**.

## What is where

| Path | What it is |
|---|---|
| \`src/gadget/\` | The gadget's own files, as they were${hadServer ? "" : " (it had no `server.js`, so an empty one stands in)"}. \`server.js\` exports \`Gadget\`, the Durable Object that holds its state. |
| \`public/client.js\` | The gadget's page code, as it was${hadClient ? "" : " (it had none, so a placeholder stands in)"}. |
| \`src/worker.js\` | The Worker. It connects the page to the Durable Object at \`/api\`, serves the gadget's own export formats at \`/export/<id>\`, and gives the gadget's code its \`env\`. |
| \`public/runtime.js\` | What the Workshop's frame gave the page: the \`gadget\` stub, \`RpcTarget\`, \`voice\` and \`downloads\`. |
| \`public/index.html\` | The page. Its content security policy lets it load its own scripts and call its own \`/api\`, and nothing else, as in the Workshop. |
| \`src/vendor/capnweb.js\`, \`public/capnweb.js\` | [Cap'n Web](https://github.com/cloudflare/capnweb) ${runtime.capnwebVersion}, the RPC library both sides speak (MIT; see \`LICENSE-capnweb.txt\`). |
| \`src/project.js\` | The gadget's title and the names of its Workshop connections. |
| \`wrangler.jsonc\` | The Worker's configuration. |

## What is different from the Workshop

- **Its data starts empty.** This is the gadget's code. What the gadget stored in the Workshop
  stays there; the Durable Object here begins with nothing.
- **There is one gadget object**, shared by everyone who opens the page, as in the Workshop.
- **No voice.** \`voice.available()\` answers false.
- **Exports.** The Workshop made the HTML and PDF exports with its own browser; here, print the
  page. A format the gadget's own \`ExportHandler\` makes is at \`/export/<id>\`, and \`/export\` lists
  them.
- **No persistent stubs.** \`this.ctx.restore()\` is the Workshop's and is not defined here. It
  handed the Workshop's connections a stub to call the gadget back with, and those connections
  are not here either.
- **The agent is gone.** Change the code with any editor and \`npx wrangler deploy\` again.

## Connections

${bindings}
## Adding Cloudflare products

This is an ordinary Worker now, so it can use the rest of the platform. Add a binding to
\`wrangler.jsonc\` and the gadget's code finds it as \`this.env.<NAME>\`: an R2 bucket for files, D1
for a shared database, KV, Queues, a Workflow for long-running steps, Workers AI for models. The
page may also call an API of your own once you add its address to \`connect-src\` in
\`public/index.html\`.
`;
}

/**
 * The files of the project for a gadget, by path under the project's own directory (named by
 * `projectSlug(input.title)`).
 */
export function buildProjectFiles(input: ProjectInput, runtime: ProjectRuntime): Map<string, string> {
  const slug = projectSlug(input.title);
  const usesAi = input.bindings.some(binding => binding.kind === "aiModel");
  const hadServer = input.files.has("server.js");
  const hadClient = input.files.has("client.js");
  const files = new Map<string, string>();
  const put = (path: string, text: string) => files.set(`${slug}/${path}`, text);

  put("README.md", readme(input, slug, runtime, hadServer, hadClient));
  put("package.json", `${JSON.stringify({
    name: slug,
    private: true,
    type: "module",
    scripts: {dev: "wrangler dev", deploy: "wrangler deploy"},
    devDependencies: {wrangler: "^4"},
  }, null, 2)}\n`);
  put("wrangler.jsonc", wranglerConfig(slug, usesAi));
  put(".gitignore", "node_modules/\n.wrangler/\n.dev.vars\n");
  put("LICENSE-capnweb.txt", runtime.capnwebLicense);
  put("src/worker.js", runtime.worker);
  put("src/project.js", `// What this project was exported from. src/worker.js reads it.
export const PROJECT = ${JSON.stringify({
    title: input.title,
    slug,
    bindings: input.bindings.map(({name, title, kind}) => ({name, title, kind})),
  }, null, 2)};
`);
  put("src/vendor/capnweb.js", runtime.capnwebWorkers);
  put("public/index.html", indexHtml(input.title));
  put("public/runtime.js", runtime.page);
  put("public/capnweb.js", runtime.capnwebBrowser);
  put("public/client.js", input.files.get("client.js") ?? EMPTY_CLIENT);
  if (!hadServer) put("src/gadget/server.js", EMPTY_SERVER);
  for (const [path, text] of input.files) {
    if (path === "client.js" || !safePath(path)) continue;
    put(`src/gadget/${path}`, text);
  }
  return files;
}

// ---- The archive --------------------------------------------------------------------------------

/**
 * A ZIP of text files, in the order given (zipFiles()). A project is a few hundred kilobytes, so
 * nothing here needs to stream.
 */
export function zipTextFiles(files: ReadonlyMap<string, string>): Promise<Uint8Array> {
  return zipFiles(files);
}

/** The project for a gadget as a ZIP archive: one directory, named by `projectSlug(input.title)`. */
export async function projectArchive(input: ProjectInput): Promise<ReadableStream<Uint8Array>> {
  const files = buildProjectFiles(input, JSON.parse(PROJECT_RUNTIME) as ProjectRuntime);
  return new Blob([await zipTextFiles(files)]).stream();
}
