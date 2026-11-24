# Taking files and gadgets out of the Workshop

A gadget's files leave the Workshop through its **export formats**: the list the Export menu shows
(`GadgetClient.getExportFormats()` / `export()`). A gadget with no `ExportHandler` gets HTML and PDF;
one that exports an `ExportHandler` from `server.js` lists its own
(`packages/workshop-backend/src/gadget-export.ts`). Two things build on that list. A deployment
admin's copy of a gadget is apart from it (see
[An admin's copy of a gadget](#an-admins-copy-of-a-gadget)).

## Saving a file from inside a gadget

A gadget's frame is sandboxed without `allow-downloads`, so a link with a `download` attribute, a
`blob:` URL and `window.open()` all save nothing. The Workshop page saves for it: `client.js` gets a
`downloads` global, an RPC stub to `GadgetDownloadsHost`
(`packages/workshop-frontend/src/features/gadget-downloads/gadgetDownloadsHost.ts`) over a
MessagePort of its own, set up by the code `GadgetUI.tsx` injects before the gadget's, as `voice` is.

| Call | What it does |
| --- | --- |
| `downloads.save(formatId)` | Saves the gadget's export format `formatId` to the person's device, exactly as picking it in the Export menu does. Resolves `true` once saved, `false` if the person cancelled. |

What it can save is only what the gadget's own export formats list, so a gadget offers a file by
listing it as a server-mode format: `getExportFormats(gadget)` is asked each time, and may list one
format per file from the gadget's state (at most 32). The file's bytes go from the gadget's
`ExportHandler` to the Workshop page; they never pass through the frame.

The frame runs code an agent wrote, perhaps from someone else's blueprint, so it may not put a file
on a person's device by itself:

- A save that follows a click in the frame goes ahead. A click in a frame counts for its ancestors
  too, for a few seconds (`navigator.userActivation`).
- A save that does not is put to the person in the Workshop's own bar ("This gadget wants to save a
  file: …") and happens only on **Save**. So is one whose click the browser no longer counts by the
  time its save dialog would open.
- One file is saved at a time.

The export limits apply as they do from the menu: 30 seconds and 100 MB
(`packages/workshop-backend/src/export-limits.ts`).

## A gadget as a Cloudflare Worker project

The Export menu offers whoever may read a gadget's code (its owner and "build" collaborators, not
"use" ones) one more format, **Cloudflare Worker project**: a ZIP that `npx wrangler deploy` turns
into a Worker of its own, on the person's Cloudflare account, with no Workshop behind it. It is
listed after the gadget's other formats, whatever they are, and its id (`cloudflare-project`) is
reserved. `packages/workshop-backend/src/project-export.ts` builds it.

| In the ZIP | What it is |
| --- | --- |
| `src/gadget/**` | Every file of the gadget but `client.js`, untouched. `server.js` exports `Gadget`. |
| `public/client.js` | The gadget's page code, untouched. |
| `src/worker.js` | `packages/workshop-backend/project-runtime/worker.js`. Serves `/api` (Cap'n Web to the Durable Object, as the Workshop's connection was) and `/export/<id>` (the gadget's own `ExportHandler`), and gives the gadget's code an `env` like the Workshop's. |
| `public/runtime.js` | `project-runtime/page.js`. Provides what the frame did: `gadget` (reconnecting), `RpcTarget`, `RpcStub`, `newMessagePortRpcSession`, `voice` (unavailable) and `downloads`. They are globals here, which a page written for the frame cannot tell from the frame's own. |
| `public/index.html` | Loads `runtime.js`, then `client.js`. Its content security policy is the frame's, opened to the Worker's own origin. |
| `src/vendor/capnweb.js`, `public/capnweb.js` | Cap'n Web for each side, at the Workshop's own version, so the project has no dependency but Wrangler. |
| `wrangler.jsonc` | The Worker, a `Gadget` Durable Object on SQLite storage, and `public/` as static assets. |
| `README.md` | How to run and deploy it, and everything below, for the person who receives it. |

What does not go with it, which its README says:

- **Sign-in.** Nothing in the project signs anyone in: whoever has the address can call every
  method of the gadget. The README says to put Cloudflare Access in front of it.
- **Data.** The project is code. The Durable Object starts empty.
- **Connections.** A binding is a session of this workspace's, approved here, so none is carried.
  The project records each binding's name, what it was connected to and its kind, and stands a stub
  in for it whose every call fails naming it. A language-model binding is the exception: it becomes
  `run({ prompt, systemPrompt })` on Workers AI (an `ai` binding, and an `AI_MODEL` variable naming
  the model). A binding of the same name that the person adds to `wrangler.jsonc` wins over the
  stand-in.
- **Workshop features.** No `voice`, no `ctx.restore()`, no browser-made HTML or PDF.

A gadget with viewer sessions (`openViewerSession`, `docs/viewer-sessions.md`) is given its session
target as in the Workshop; the viewer is named by Cloudflare Access's
`Cf-Access-Authenticated-User-Email` header, and is one anonymous owner without it.

The runtime files are copied into `src/generated/project-runtime.txt` by
`scripts/build-browser-runtime.ts`, with Cap'n Web's two builds, version and licence.
The ZIP is written by `zipFiles()` (`packages/workshop-shared/src/zip.ts`), which the admin's copy
below and the browser use too, and the directory is named by its `fileNameSlug()`.
`__tests__/project-export.test.ts` covers the files and the archive; the integration tests export a
gadget through a running Workshop and read the ZIP back (`workshop-blueprints.test.ts`), and check
that a "use" collaborator is neither offered the project nor given it (`workshop-use-role.test.ts`).
Changing `project-runtime/` means running a project under `wrangler dev` in a browser: unzip an
export, `npx wrangler dev`, and open the page.

## An admin's copy of a gadget

A deployment admin whose access level is `"content"` can take a copy of any permanent gadget
through `AdminWorkspaceView.exportGadget(gadgetId, mode)`, recorded in the admin audit log before it
leaves the server ([admin-access.md](admin-access.md#copying-a-gadget) has the whole of it):

| Mode | File | What it holds |
| --- | --- | --- |
| `"code"` | `<slug>.gadget` | A blueprint archive of the gadget's committed head, as publishing would make it but publishing nothing: any Cloudflare OS takes it in through **Import blueprint**. No history, no data. |
| `"everything"` | `<slug>.zip` | That archive, `<slug>.data.json` (the gadget's SQLite tables and key-value storage, `"format": "cloudflare-os/gadget-data"`, `"version": 1`) and a `README.md` saying what each file is. Taking the data pauses the gadget, so anyone connected reconnects once. |

`<slug>` is `fileNameSlug()` of the gadget's title. Nothing imports a `data.json` yet: it restores
by hand, as its README says. The export limits apply: 30 seconds and 100 MB for the copy, and
16 MB for the data in an `"everything"` copy, measured before it is read, so a gadget with more
can be copied as `"code"` alone.
