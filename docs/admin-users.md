# The admin Users page

The Users tab of the admin panel (**Admin → Users**) is where a deployment's admins look at its
accounts: who has signed in, what each has spent, and, with a reason given, what an account holds,
down to a copy of its gadgets. It is a front end to calls [admin-access.md](admin-access.md)
describes: the directory's `listUsers()`, `inspectUser()` and `inspectWorkspace()`, and the audit
log. This document says what the page shows and how its layers fit; the API, the withheld fields
and the audit's records are in admin-access.md.

Only deployment admins reach it. `AuthenticatedApi.getAdminApi()` returns null for anyone else, so a
non-admin has no `AdminApi` to call and the admin panel shows them nothing of this. The code is
`packages/workshop-frontend/src/features/admin-users/`.

## The layers

The page reads in three layers, and each is held to a different rule:

1. **The table** lists accounts from the user directory. These reads are not recorded and show the
   same whatever the access level, since an admin uses them to find a user.
2. **A user's panel** opens one account through `inspectUser()` and its workspaces through
   `inspectWorkspace()`. Every open and every call after it is recorded in the audit log, under a
   reason the admin gives first. What it shows depends on the access level.
3. **Downloads** copy a gadget's code, or its code and stored data. They need the `content` level,
   and the data read briefly stops the gadget (see [The reader's pause](#the-readers-pause)).

## The table

One row per account, 50 to a page, with **Previous** and **Next** to turn pages:

| Column | Shows |
| --- | --- |
| User | The name, the canonical id and an Admin badge for a deployment admin |
| Workspaces | How many workspaces the directory lists with this user as owner |
| Last sign-in | The last login the account told the directory of (to within an hour) |
| Joined | When the account was created |
| Total cost | The account's total cost in US dollars |

- **Search** matches a name or an id, and applies once typing pauses.
- **Active** keeps users who last signed in within 7 or 30 days, or since a chosen date. An account
  with no recorded login is left out of any such filter.
- **Has spend** keeps users whose total cost is above zero.
- **Sort**: the User, Last sign-in, Joined and Total cost headers order the table, and a second
  click on the same header reverses it. User starts ascending; the others start with the highest or
  newest. Users with no value for the column come last, either way. Any change to the search, the
  filter or the order returns to the first page.

Total cost is the figure the account last reported to the directory, not a reading of its ledger,
so it can lag a little behind what the user has spent. The exact figure is on the user's Usage tab.

The directory fills lazily: an account is listed once it has started a session since the directory
began recording accounts, and a user who has not signed in since then is missing until they do.
Accounts listed this way can show a dash for Last sign-in or Joined. See
[What the lazy backfill misses](admin-access.md#what-the-lazy-backfill-misses).

## Opening a user

A click on a row opens the user's panel as a drawer. Before anything is read, it asks for a
**reason**, prefilled with "Reviewing <name>'s work" for the admin to keep or replace. The reason is
recorded with the open and with every call that follows, so it must be given (not blank, and no
longer than `MAX_ADMIN_ACCESS_REASON_LENGTH`). A reason belongs to the user it was given for:
opening another user asks again.

The panel's reads go through views that expire (15 minutes unless asked otherwise). The page
reopens an expired view once, on its own, and records that open as the audit records any other. A
workspace is opened only when a tab needs it, and at most four are opened at a time, because each
open is recorded and wakes the workspace.

The address of an open panel is `/admin?tab=users&user=<id>`, so an admin can send it to another
admin. Following it asks for a reason as a click does: the link carries no view and no reason.

At level `off` the table still lists users, but a panel opened on one reads nothing and says that
admin access is turned off on this deployment. The refused open is recorded.

## The tabs

A user's panel has five tabs. Each reads through the user's or a workspace's audited view, and only
what the `metadata` level allows (see [Access levels](#access-levels)).

- **Usage** is the account's total cost, with its cost by kind (text, image, video, music, speech,
  transcription) and by model (cost, requests and tokens, marked as estimated when part of it is),
  and the deleted workspaces' share. Below that is each owned workspace's storage and the last
  measured size of its gadgets' data, and the services the user's gadgets are connected to: AI
  models, Gatekeepers and the number of agent spawners. If the cost summary cannot be read, the
  total is the owned workspaces' costs added up and the breakdowns are left out.
- **Workspaces** lists the workspaces the user owns, with created and last active times, gadget
  count, cost and storage, and the ones shared with them, with owner and role. A workspace whose
  view cannot be opened shows dashes.
- **Gadgets** lists every gadget in every workspace the user owns, with its workspace, the
  connections bound to it, its last measured data size and its download menu.
- **Blueprints** lists the blueprints the account holds: those the user published or imported, and
  those in their library, with version, last update and whether one is featured. Blueprint ids are
  not shown.
- **Sharing** lists, for each owned workspace, its collaborators with their role and what they may
  open, and its active share links (note, role, gadget, who created each and when). A revoked link
  does not appear.

## Downloads

Each row of the Gadgets tab has a **Download** menu, and the panel's header has one for **all
gadgets**. The menu offers:

- **Code only**: `<slug>.gadget`, a blueprint archive of the gadget's committed head that any
  Cloudflare OS takes in through **Import blueprint**. It carries no history and no data, and it
  pauses nothing.
- **Everything**: `<slug>.zip`, holding that archive, `<slug>.data.json` and a `README.md`. The
  data is the gadget's SQLite tables and key-value storage, in the `cloudflare-os/gadget-data`
  format, version 1. The README says what each file is;
  [gadget-export.md](gadget-export.md#an-admins-copy-of-a-gadget) and
  [admin-access.md](admin-access.md#copying-a-gadget) have the format and the rest. Nothing
  imports a `data.json` yet: a gadget made from the archive starts empty, and the data goes back by
  hand.
- **Measure size**, on a gadget's row only: reads the gadget's storage to record its size, shown in
  the Data size column and under Usage. It writes nothing but that size to the workspace.

`<slug>` is made from the gadget's title. A copy is refused at the server once it would exceed
100 MB or take longer than 30 seconds, and a gadget's committed code, packed, may not exceed 32 MB
(`MAX_RELEASE_PACK_BYTES`). Everything also refuses a gadget whose stored data is larger than
16 MB, before reading any of it; Code only still copies that gadget. A failed copy shows its
message under the menu.

**Download all** copies every gadget in every workspace the user owns, one after another, into one
ZIP named for the user (`<user id>-gadgets.zip`) with a folder per workspace, named by its title,
and a top-level `README.md`. A gadget that fails does not stop the rest: the README lists it with
its message, and lists any workspace whose gadgets could not be listed at all. Progress shows as
gadgets done of the total. The page builds the ZIP in the browser, so every copy is held in the
browser's memory until it is saved: a user with a great deal of data can exhaust it, and their
gadgets are better taken one at a time.

Everything and Measure size, and Download all's Everything, ask first, saying that anyone using the
gadget will see it reconnect once.

## Access levels

One setting, chosen by admins in **Admin → Audit** and capped by the deployment's
`ADMIN_WORKSPACE_ACCESS_MAX`, governs the page. See [The levels](admin-access.md#the-levels).

| Level | The table | The tabs | Downloads |
| --- | --- | --- | --- |
| `off` | Listed | Nothing: the panel says admin access is turned off | Nothing |
| `metadata` (the default) | Listed | All five | Disabled, saying "Downloads need the content access level" |
| `content` | Listed | The same as `metadata` | Code only, Everything and Measure size |

The `content` level adds gadget code and stored data, and nothing else: chat messages, attachments,
file contents outside a gadget's code and commit messages stay withheld at every level. It is
reachable only when the deployment sets `ADMIN_WORKSPACE_ACCESS_MAX=content`; without it, a
deployment never has the level and the download controls stay disabled. The page disables downloads
when it knows the level is below `content`, and the server refuses them whatever the page shows.

## The reader's pause

A gadget's data belongs to the gadget's own runtime, and only code running there can open it. To
read it, the Workshop stops the gadget and starts a reader of its own in its place, with the same
storage ([the steps](admin-access.md#reading-a-gadgets-stored-data)). An Everything copy and a size
measurement both do this:

- The gadget stops with the message "Paused while an admin takes a copy".
- People connected to the gadget see it reconnect once.
- A page that connects while the read runs waits, and gets the gadget once the read ends.
- The reader writes nothing. When the read ends, successfully or not, the gadget starts again with
  its data intact.

Code only never pauses the gadget. Reads of one gadget run one at a time, and Download all copies
gadgets in sequence.

## The audit

Every open, every read and every download is recorded in the deployment-wide audit log, with the
admin, the reason and the access level in force. So are refusals: a read refused because the level
is `off`, a download refused because the level is below `content`, and a read that failed. A copy is
recorded before its bytes leave the server. [Which refusals are
recorded](admin-access.md#which-refusals-are-recorded) lists what is and is not. Nothing a user can
read shows an inspection, unless they are a deployment admin who reads the log.

## What depends on the cost ledger

The table, the tabs other than Usage's cost sections, and the downloads depend only on the admin
access surface. The cost sections depend on the cost ledger
([cost-accounting.md](cost-accounting.md)): Usage's cost by kind and by model, the Total cost
column, its sort and the Has spend filter.

