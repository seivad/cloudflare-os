// The Worker a gadget runs in outside the Workshop. Exported with the gadget by Cloudflare OS; it
// is yours to change.
//
//   browser ── public/ (index.html, runtime.js, capnweb.js, client.js) ── static assets
//           ── WebSocket /api ──▶ this Worker ──▶ the Gadget Durable Object (src/gadget/server.js)
//           ── GET /export/<id> ─▶ this Worker ──▶ the gadget's ExportHandler, if it has one
//
// In the Workshop, the page's `gadget` stub reached the gadget's object through the Workshop. Here
// it reaches it through /api: Cap'n Web (src/vendor/capnweb.js) carries each `gadget.method()` call
// to the Durable Object, and callbacks the page passes back the other way.
//
// IMPORTANT: nothing here signs anyone in. Whoever can open this Worker's address can call every
// method of the gadget. Put Cloudflare Access in front of it unless it is meant for everyone
// (README.md says how).

import { RpcTarget } from "cloudflare:workers";
import { newWorkersRpcResponse } from "./vendor/capnweb.js";
import * as gadgetModule from "./gadget/server.js";
import { PROJECT } from "./project.js";

// Everything server.js exports is exported here too (its ExportHandler, any other entrypoint),
// except Gadget, which the class below stands in for.
export * from "./gadget/server.js";

/** The name the one gadget object goes by in its Durable Object namespace. */
const OBJECT_NAME = "gadget";

/**
 * A stand-in for a Workshop connection this project does not have. In the Workshop each binding
 * was a connection the person had approved (a repository, a calendar, a model); none of them comes
 * along with the code. Every call on one fails saying which it was.
 */
function missingBinding(name, what) {
  const error = () =>
    new Error(`env.${name} was a Workshop connection (${what}) and is not part of this exported project. Bind your own under that name in wrangler.jsonc; see README.md.`);
  return new Proxy({}, {
    get(_target, property) {
      if (property === "then" || typeof property === "symbol") return undefined;
      return () => Promise.reject(error());
    },
  });
}

/** The text of a Workers AI text-generation answer, whichever of its shapes the model gives. */
function generatedText(answer) {
  if (typeof answer === "string") return answer;
  if (typeof answer?.response === "string") return answer.response;
  const message = answer?.choices?.[0]?.message?.content;
  if (typeof message === "string") return message;
  throw new Error("The model's answer held no text.");
}

/**
 * The Workshop's language-model binding (`run({prompt, systemPrompt})` answering text), on Workers
 * AI: the `AI` binding in wrangler.jsonc, and the model its `AI_MODEL` variable names.
 */
function languageModel(env) {
  return {
    async run(options) {
      const messages = [];
      if (options?.systemPrompt) messages.push({ role: "system", content: String(options.systemPrompt) });
      messages.push({ role: "user", content: String(options?.prompt ?? "") });
      return generatedText(await env.AI.run(env.AI_MODEL, { messages }));
    },
  };
}

/**
 * The `env` the gadget's code sees: this Worker's own bindings, the gadget itself as `GADGET`, and
 * a stand-in for each connection the gadget had in the Workshop that nothing real is bound for.
 */
function gadgetEnv(ctx, env) {
  const result = { ...env };
  result.GADGET = env.GADGET_OBJECT.get(ctx.id);
  if (!("GIT" in env)) result.GIT = missingBinding("GIT", "the Workshop's git store");
  for (const binding of PROJECT.bindings) {
    if (binding.name in env) continue;
    result[binding.name] = binding.kind === "aiModel" && env.AI && env.AI_MODEL ? languageModel(env) : missingBinding(binding.name, binding.title);
  }
  return result;
}

export class Gadget extends gadgetModule.Gadget {
  constructor(ctx, env) {
    super(ctx, gadgetEnv(ctx, env));
  }
}

/** Who is calling, for a gadget that keeps a session a viewer (`openViewerSession`). Cloudflare Access names them; without it everyone is one anonymous owner. */
function viewerOf(request) {
  const email = request.headers.get("cf-access-authenticated-user-email");
  return email ? { profileId: email, name: email, role: "owner" } : { profileId: "anonymous", name: "Anonymous", role: "owner" };
}

/** Methods of the object that only the platform or this Worker calls. */
const NOT_FOR_PAGES = new Set(["constructor", "fetch", "alarm", "webSocketMessage", "webSocketClose", "webSocketError", "openViewerSession"]);

/**
 * What the page's `gadget` stub is connected to: the gadget's object, behind a target that passes
 * every method call on. A gadget with viewer sessions gets the target its `openViewerSession()`
 * returns instead, as it does in the Workshop.
 */
function gadgetTarget(env, request) {
  const object = env.GADGET_OBJECT.get(env.GADGET_OBJECT.idFromName(OBJECT_NAME));
  if (typeof gadgetModule.Gadget.prototype.openViewerSession === "function") return object.openViewerSession(viewerOf(request));
  return new Proxy(new RpcTarget(), {
    get(target, property, receiver) {
      if (typeof property === "symbol" || property in target) return Reflect.get(target, property, receiver);
      // Not a promise; and what the platform calls on the object is not the page's to call.
      if (property === "then" || NOT_FOR_PAGES.has(property)) return undefined;
      return (...args) => object[property](...args);
    },
  });
}

/** One of the gadget's export formats as a download, or the list of them. */
async function exportResponse(env, ctx, id) {
  const handler = ctx.exports?.ExportHandler;
  if (!handler) return new Response("This gadget has no export formats of its own.", { status: 404 });
  const object = env.GADGET_OBJECT.get(env.GADGET_OBJECT.idFromName(OBJECT_NAME));
  const formats = await handler.getExportFormats(object);
  if (id === "") return Response.json(formats);
  const format = formats.find((candidate) => candidate.id === id);
  if (!format) return new Response("No such export format.", { status: 404 });
  if (format.mode !== "server") return new Response("This format was captured by the Workshop's browser. Print the page instead.", { status: 400 });
  const fileName = (format.fileName ?? `${PROJECT.slug}${format.fileExtension}`).replace(/[^A-Za-z0-9._-]+/g, "-");
  return new Response(await handler.export(object, id), {
    headers: { "content-type": format.contentType, "content-disposition": `attachment; filename="${fileName}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api") return newWorkersRpcResponse(request, await gadgetTarget(env, request));
    if (url.pathname === "/export" || url.pathname.startsWith("/export/")) {
      if (request.method !== "GET") return new Response("Method not allowed.", { status: 405, headers: { allow: "GET" } });
      try {
        return await exportResponse(env, ctx, decodeURIComponent(url.pathname.slice("/export/".length)));
      } catch (error) {
        return new Response(`The export failed: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
      }
    }
    return new Response("Not found.", { status: 404 });
  },
};
