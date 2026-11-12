# Viewer sessions

A gadget normally cannot tell who is using it. `GadgetClient.connectToGadget()` hands every client
the same stub to the gadget's Durable Object facet, whether they are the owner, a `build`
collaborator or a `use` collaborator (see [sharing.md](sharing.md)). A gadget that needs to know,
to record who did what or to refuse some actions to `use` collaborators, opts into **viewer
sessions**: the Workshop then tells it who is connecting, and the client talks to an object the
gadget made for that one person.

## Opting in

Two things, both on the gadget's side:

- Its blueprint release's metadata sets `"viewerSessions": true` (`BlueprintMetadata.viewerSessions`;
  only `true` counts), for example in the metadata of the `.gadget` archive it is imported from.
- Its `Gadget` Durable Object implements `openViewerSession(viewer: GadgetViewer): RpcTarget`, and
  follows the rules under "Who can open a session" below.

The flag follows the code the gadget runs. A gadget records it with each blueprint release it takes
(`GadgetUpstream.viewerSessions`, beside the release's `commitId`): when it is instantiated from a
release, when the agent's creation of it from a release is accepted, and when a proposal to merge a
release into it is accepted (`BlueprintMerge.viewerSessions` carries the flag until then). A connect
reads that record and nothing else, so republishing the blueprint changes nothing until the gadget
takes the new release, and deleting the blueprint changes nothing at all. A gadget that has taken no
release (built from scratch, of unknown origin, or still provisional to a chat) gets the facet stub.
A blueprint published from a workspace never carries the flag (`createBlueprint` writes only the
metadata it derives), so a gadget republished as a new blueprint, and gadgets made from that, lose
it.

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
to its methods. Exceptions they throw reach the console logs, as the facet's do. If
`openViewerSession()` throws, or returns something that is not an object, the connect fails and is
reported the same way. The owner's and `build` collaborators' previews of a chat's proposed changes
(`connectToGadget(chatId)`) open sessions on the chat's code too, but whether they do is decided by
the release the gadget runs on mainline: a chat proposing to take a release that adds or drops the
flag previews with the gadget's current setting until it is accepted.

## Who can open a session

The Workshop calls `openViewerSession()` itself, and every stub to the gadget it hands out refuses
the call, whoever holds it: a client of any role, an agent, or another gadget through a binding. So
no stub the Workshop mints can open a session as someone else.

The gadget's own code can still undo that. Whoever holds a reference to its Durable Object itself
can call `openViewerSession({role: "owner", ...})` directly. A method that returns `this`, or a
`[restore]()` that returns `this` for an agent or a hook, hands one out. And the facet stub, which
bindings always get, reaches every other method of the Durable Object. So a gadget that opts in
must:

- never hand out its Durable Object itself, only RpcTargets built for the purpose, and
- keep every action a viewer's role gates on its session objects, never on the Durable Object's own
  methods.

## Lifetime

A viewer session counts as a collaborator session exactly as the facet stub does (see
[observers.md](observers.md)): it is counted from before the gadget is asked, as a session holding
that gadget for a `use` collaborator, and released when the client disposes it, which also disposes
the gadget's target. A restart that severs sessions (a collaborator removed or narrowed, a share link
revoked, a verification scope widened) aborts the facet, so the session's next call rejects and the
client reconnects with its new access, opening a new session. Objects a viewer session returns are
the gadget's own children, outside the count, like those the facet stub returns.
