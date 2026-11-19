// The page side of a gadget that runs as its own Worker: what the Workshop's frame gave client.js,
// provided here instead. index.html loads this module and then client.js, which finds `gadget`,
// `RpcTarget`, `RpcStub` and the rest as globals.
//
// Exported with the gadget by Cloudflare OS. It is yours to change.

import { RpcTarget, RpcStub, newMessagePortRpcSession, newWebSocketRpcSession } from "./capnweb.js";

/**
 * `gadget`: the gadget's Durable Object, over a WebSocket to this Worker's /api. A call made after
 * the connection has dropped opens a new one, as the Workshop's stub does; callbacks and other
 * stubs passed over the old connection are disposed with it, so a subscription made with one
 * resubscribes from its `[Symbol.dispose]()`.
 */
function connectedGadget() {
  const url = new URL("/api", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let session = null;
  const current = () => {
    if (session === null) {
      const opened = newWebSocketRpcSession(url.href);
      opened.onRpcBroken(() => {
        if (session === opened) session = null;
      });
      session = opened;
    }
    return session;
  };
  const self = new Proxy(function () {}, {
    get(_target, property) {
      // Not a promise, and nothing to release: the connection lasts as long as the page.
      if (property === "then") return undefined;
      if (property === "dup") return () => self;
      if (property === "onRpcBroken") return () => {};
      if (property === Symbol.dispose) return () => {};
      if (typeof property === "symbol") return undefined;
      return (...args) => current()[property](...args);
    },
  });
  return self;
}

const unavailable = (what) => () => Promise.reject(new Error(`${what} is part of the Workshop and is not available in this exported project.`));

Object.assign(globalThis, {
  RpcTarget,
  RpcStub,
  newMessagePortRpcSession,
  gadget: connectedGadget(),
  // The Workshop's speech to text and text to speech. There is none here: `available()` says so,
  // which is what a gadget checks before it shows a microphone.
  voice: {
    available: async () => false,
    models: async () => [],
    listen: unavailable("Voice"),
    stopListening: async () => {},
    speak: unavailable("Voice"),
    stopSpeaking: async () => {},
    synthesize: unavailable("Voice"),
  },
  // Saves one of the gadget's export formats (the `ExportHandler` in server.js) as a file.
  downloads: {
    async save(formatId) {
      const link = document.createElement("a");
      link.href = `/export/${encodeURIComponent(String(formatId))}`;
      link.download = "";
      link.style.display = "none";
      document.body.append(link);
      link.click();
      link.remove();
      return true;
    },
  },
});
