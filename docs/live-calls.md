# Live calls

Every gadget can have a live video call: people looking at the same gadget see one another's
webcams in a sidebar beside it, and can invite others to join. Calls run on
[Cloudflare RealtimeKit](https://developers.cloudflare.com/realtime/realtimekit/). The Workshop
backend creates the meetings and issues every participant token; the frontend joins with the
RealtimeKit Core SDK and draws its own UI.

A call is as narrow as the gadget's access. Exactly the people who hold the gadget can join its
call: the owner, `build` collaborators, and `use` collaborators given that gadget (see
[sharing.md](sharing.md)). Nobody else can get a ticket, and someone who loses the gadget is
removed from its call.

## Configuration

Live calls are available only when the Workshop has all three of:

- `REALTIMEKIT_ACCOUNT_ID`: the Cloudflare account that owns the RealtimeKit app.
- `REALTIMEKIT_APP_ID`: the app.
- `REALTIMEKIT_API_TOKEN` (a secret): an account API token with the **Realtime Admin**
  permission.

`ServerConfig.liveCallsEnabled` reports whether they are set, and the frontend shows no live-call
UI when it is false. Every `GadgetClient` call method throws "Live calls are not available" then.

The Workshop sets up the rest itself. On the first join it creates the preset `cf-os-live` in the
app if it is missing: a group call with audio and video, and no screen share, chat, polls,
plugins, recording, livestream, transcription or waiting room. Nobody is hidden, nobody can act
on anyone else, and nobody can rename themselves, since names come from Workshop profiles. A
preset of that name that already exists is used as it is, so an operator can also create it in
the dashboard, or adjust it there, for instance to change the video quality.

## The call of a gadget

Each gadget's call is one RealtimeKit meeting, created on the gadget's first join and recorded in
the Overseer's `callMeetings`. A meeting is created with a generic title and with recording and
transcription off: nothing about the gadget is sent to RealtimeKit.

Each person who joins becomes one RealtimeKit participant in that meeting, recorded in
`callParticipants` and reused for every later join. Their `custom_participant_id` is their User DO
id, which is opaque and stable, never their email. Their name is their profile name (the local
part of their profile id if the name is blank), fixed when the participant is added.

Concurrent joins create one meeting and one participant per person: creation is serialized per
gadget and per person in memory, and storage is read again after every await.

### Tickets

`GadgetClient.joinCall()` returns a `CallTicket`: a RealtimeKit participant token that admits new
connections for four hours (`CALL_TICKET_TTL_MS`), with the name the call shows. A rejoin refreshes
the token of the existing participant rather than adding another. RealtimeKit keeps a connection
already made past the token's expiry, so a call outlasts its ticket; the SDK's reconnect after an
expiry needs a new ticket, which the frontend asks for while it still holds the gadget.

Holding the gadget's capability is what authorizes a join, so the restricted
`UseGadgetClientInterface` allows it as well as `GadgetClientImpl`. The capability is not the only
check, though. A capability dies only with the restart that follows a revocation, about 100ms
later, while a ticket lives for hours. So `LiveCalls.join()` also checks the caller's live
effective access, before any RealtimeKit request and again after each one, in the same
synchronous step that stores the participant or returns the token. A revocation landing during a
join either happens before that step, which then refuses and retires the participant just added,
or after it, and then retires the stored participant like any other.

The workspace being deleted, or the gadget being deleted or still provisional to a chat, refuses
a join the same way. The refusal is "No such gadget", as `getGadget()` refuses a gadget the caller
does not hold.

### Roster

`GadgetClient.getCallRoster()` lists who is in the call now, in join order, from RealtimeKit's
active session and its participants. One lookup per gadget is shared for ten seconds
(`CALL_ROSTER_CACHE_MS`), so any number of viewers polling costs one lookup per interval. Each
person in the lookup is matched to the participants stored now, so someone revoked drops out at
once. The roster checks only that the gadget exists, not the caller's live access: it shows the
same thing presence does, to the same people.

## Invitations

`GadgetClient.inviteToCall(profileId)` tells the invitee's open tabs at once, through
`UserDurableObject.notifyCallInvite()` and `NotificationSubscriber.callInvite()`. Nothing is stored,
and nothing falls back to push: an invitation is only useful while the call is happening. A tab
from before live calls has no `callInvite()`, and its rejection is ignored.

- Only the owner and `build` collaborators can invite, as only they can share.
  `UseGadgetClientInterface.inviteToCall()` throws `Unauthorized`.
- The inviter must still hold the gadget, by live access.
- The invitee must already hold the gadget. An invitation grants nothing, so a client inviting
  someone who lacks the gadget shares it with them first, with `addCollaborator()`.
- One person can invite another to one gadget's call at most once per 20 seconds
  (`CALL_INVITE_INTERVAL_MS`), counted in memory.
- A `CallInvite` carries the workspace and gadget ids, the gadget's title and the inviter's
  profile. Once the workspace holds restricted data the title is withheld (`""`), as for a share
  notification: the invitee has not necessarily been verified as an observer of what it read.

## Revocation

Losing a gadget has to remove someone from its call, and the Overseer's restart does not: a live
call is a connection to RealtimeKit, not a session of the Overseer. Deleting their RealtimeKit
participant does, since it revokes every token the participant was issued and removes them from
the meeting's live session at once.

So whenever a sharing change narrows anyone's access -- `removeCollaborator`, `revokeShareLink`,
and `ownerInvitesOnly` taking effect, including everyone narrowed transitively -- the Overseer
retires each of their participants in a call of a gadget their new access lacks. It does so in
`refreshAffectedCollaboratorListings`, in the change's synchronous continuation, before the restart
is scheduled. Retiring a participant forgets it and journals its deletion in `callCleanup`, in the
same synchronous step, so the journal is flushed with the sharing change by the restart's
`storage.sync()`. Delivery starts at once and is retried from the Overseer's alarm until RealtimeKit
confirms; the constructor resumes it too, so the restart that follows a revocation kicks the person
as soon as the Overseer is back. A participant RealtimeKit no longer has counts as deleted.

Deleting a gadget retires all its participants and closes its meeting (`status: "INACTIVE"`, which
also removes everyone from it and stops anyone joining again), then forgets the meeting. Deleting
the workspace does the same for every gadget, and the workspace's storage is wiped only once none
of that cleanup remains.

Re-admission does not supersede a journaled deletion: someone removed and added back before the
deletion lands is kicked once, and their next join adds a new participant.

## Frontend

`LiveCallProvider` (`features/live-call/`), mounted above the authenticated app shell, holds the one
call a tab can be in, so a call survives navigating between gadgets and pages. `LiveCallSidebar` sits
beside the routed page: a column of its own on `md` and wider, a small overlay on phones, and a pill
when collapsed during a call. In a call it shows a vertical stack of webcam tiles (the caller first,
then everyone else in the order they joined, each named, with a muted-microphone mark, an outline
for whoever is speaking, and initials or an avatar when their camera is off), the caller's
microphone, camera and leave controls, and Invite at the bottom.

The gadget views -- the editor and the `use`-only view -- lend the provider the selected gadget's
capability while it is on screen (`useLiveCallGadget`), and show a Live toggle that opens the
sidebar for it. Before joining, the sidebar shows who is live (`getCallRoster()`, polled every ten
seconds while open and visible) and Join. During a call it names the call's gadget with a way back
to it, and offers Switch call while another gadget is on screen.

- The RealtimeKit SDK is loaded with a dynamic `import()` only when someone joins, so it is a chunk
  of its own, and nothing asks for the camera or microphone before then.
- A denied camera or microphone leaves them in the call receive-only, with a hint. A browser that
  blocks autoplay gets a button that starts the others' audio.
- Leaving stops every local track, even when the SDK is slow to let go of them.
- Being removed from the call ends it with a notice. A dropped connection rejoins once with a fresh
  ticket while a view of that gadget is open, and otherwise offers Rejoin.
- Invite opens the Share dialog in call mode for the call's gadget, offered only to people who can
  share (as the Share dialog decides it) and only while that gadget is on screen. It searches the
  people who hold the gadget as well as everyone else, gives the gadget with `addCollaborator()` to
  anyone the dialog doesn't list as holding it, and then invites each of them. It has no share
  links.
- An invitation shows a notice whose Join opens the workspace on the gadget with `call=join`, which
  joins once that gadget is open and is dropped then, or as soon as it can't be honoured.

The call runs in the Workshop page, never inside the gadget's sandboxed iframe, so gadget code has
no access to the camera, the microphone or the ticket. The page's only Content-Security-Policy
directive is `frame-src`, and nothing sets a Permissions-Policy, so neither blocks the SDK's
connections to `*.realtime.cloudflare.com` and Cloudflare's STUN/TURN servers, or its use of the
camera and microphone.

## Residual risks

- **A ticket is a bearer credential.** Anyone holding one can join as its participant until it
  expires, four hours at most, unless the participant is deleted first. Tickets are never logged,
  stored, or put in error messages; the API token never leaves the backend.
- **Cleanup RealtimeKit keeps refusing.** While deleting a participant fails, the person removed can
  stay in the call they are in and rejoin with an unexpired ticket. Retries continue for 24 hours,
  after which the cleanup is abandoned and logged as an error; every ticket issued for it has
  expired by then, but a connection made before can last as long as the person stays.
- **Turning live calls off.** A deployment that drops its RealtimeKit configuration can deliver no
  cleanup, so what is owed is dropped with a warning. Tickets expire on their own, but anyone in a
  call stays until they leave; end calls in the RealtimeKit dashboard for a hard stop.
- **Orphans.** A restart during a RealtimeKit request can leave a meeting or participant the
  Workshop never recorded. Nobody holds a token for one, so it admits nobody.
- **Profile names.** A participant keeps the name they had when it was added, so a later profile
  rename shows only in calls they join for the first time.
- **Not end-to-end encrypted.** Media passes through Cloudflare's RealtimeKit infrastructure, which
  also learns participants' names and the opaque ids above.
- **Billing.** RealtimeKit bills participant minutes, each tab separately.
- **Several tabs.** Each tab joins as the same participant. Should RealtimeKit remove one tab when
  another joins, the first says the person was removed from the call.
- **A full-screen gadget.** The editor's full-screen preview covers the sidebar column: the call
  carries on, out of sight.
