# Viewer sessions

A gadget normally cannot tell who is using it. `GadgetClient.connectToGadget()` hands every client
the same stub to the gadget's Durable Object facet, whether they are the owner, a `build`
collaborator or a `use` collaborator (see [sharing.md](sharing.md)). A gadget that needs to know,
to record who did what or to refuse some actions to `use` collaborators, opts into **viewer
sessions**: the Workshop then tells it who is connecting, and the client talks to an object the
gadget made for that one person.

## Opting in

Two things, both on the gadget's side:

- Its blueprint's metadata sets `"viewerSessions": true` (`BlueprintMetadata.viewerSessions`), for
  example in the metadata of the `.gadget` archive it is imported from.
- Its `Gadget` Durable Object implements `openViewerSession(viewer: GadgetViewer): RpcTarget`.

The Workshop reads the flag at every connect, from the blueprint the gadget follows
(`GadgetRecord.upstream.blueprintId`) as that blueprint is currently published in KV. A gadget that
follows no blueprint (built from scratch, of unknown origin, or still provisional to a chat) or whose
blueprint has been deleted gets the facet stub. A blueprint published from a workspace never carries
the flag (`createBlueprint` writes only the metadata it derives), so a gadget republished as a new
blueprint loses it.

## The viewer

```ts
type GadgetViewer = { profileId: string; name: string; role: "owner" | "build" | "use" };
```

The Workshop mints it from the session alone, so the gadget can trust it. `profileId` and `name` come
from the connecting user's own profile, the name falling back to the id's local part when it is
blank, as live calls name people. `role` is `"owner"` for the workspace's owner and otherwise the role
the collaborator's session was opened with. A session's role never changes: anything that changes a
collaborator's access restarts the workspace (below).

## What the client gets

`connectToGadget()` returns the RpcTarget `openViewerSession()` returned, and the client's calls go
to its methods. Exceptions they throw reach the console logs, as the facet's do. The same applies to
the owner's and `build` collaborators' previews of a chat's proposed changes (`connectToGadget(chatId)`).

Only the Workshop calls `openViewerSession()`. The facet stub refuses it whoever holds it: a client of
any role, an agent, or another gadget through a binding. So nobody can open a session as someone
else. That stub still reaches the gadget's other methods (bindings always get it, and every client
does if the flag cannot be read), so a gadget that opts in should keep anything a viewer's role must
gate off its Durable Object's own methods and expose it only through its viewer sessions.

## Lifetime

A viewer session counts as a collaborator session exactly as the facet stub does (see
[observers.md](observers.md)): it is counted from before the gadget is asked, as a session holding
that gadget for a `use` collaborator, and released when the client disposes it, which also disposes
the gadget's target. A restart that severs sessions (a collaborator removed or narrowed, a share link
revoked, a verification scope widened) aborts the facet, so the session's next call rejects and the
client reconnects with its new access, opening a new session. Objects a viewer session returns are
the gadget's own children, outside the count, like those the facet stub returns.
