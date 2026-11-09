# Skills Navigator Direction and Compatibility

The target information model is deliberately flat: a collection contains atomic skills. Each skill
encompasses its `SKILL.md` manifest and all related agentic standards files. Those files may be
stored together in a skill directory, but the navigator presents the complete bundle as one skill,
not as a file hierarchy.

Skill titles are presented as human-readable title case. Creation and rename accept that display
form, then derive the lowercase, hyphen-separated `name` required by the Agent Skills specification
for the manifest metadata and directory name.

Organizational directories are being abandoned. The navigator does not let users create, rename, or
move them, and new product behavior must not depend on adding more directory hierarchy. Directory
nodes remain only to preserve collections that already use older nested layouts.

Selecting a skill still opens the existing collection editor, which remains the general-purpose
document editing surface. Every reader can also open a collection from its row menu, so collections
that contain only ordinary documents remain reachable. Such a collection also shows an interactive
"N files, no skills" row in place of "No contents", which opens the editor directly.

## Invalid manifests

A `SKILL.md` whose frontmatter fails `parseSkillManifest` is not a skill: agents never see it, and
the skill index excludes it. The navigator still lists it, because Git pushes bypass the validation
that skill creation applies, and a hidden manifest leaves a collection looking empty with no hint
why. The row carries a warning icon and the validation message from `skillError` on the document
summary. It is named after its directory, or the collection title for a root manifest, since a
manifest that does not parse has no metadata name. Selecting it opens the manifest in the editor, as
for a valid skill. Rename and move are withheld because the server validates the manifest before
either, so they would always fail until it is fixed; delete works as for any skill. Each Git sync
that stores invalid manifests logs one `context.skill.manifest.invalid` warning naming up to ten.

## Legacy directories

Existing organizational directories remain usable for backwards compatibility: skills can be
created in them and moved into, out of, or between them, and the directories themselves can be
deleted. They cannot be created, renamed, or moved through the navigator, because the forward model
treats only skill bundles as movable units.

Legacy directories can also be deleted. Deleting one removes its complete document subtree,
including files the skills-only projection does not display. None of these compatibility behaviors
make directories part of the forward-looking data model: no operation can create another
organizational directory.

## Mutation boundaries

- Users can create, rename, move, and delete complete skill bundles, but cannot create, rename, or
  move organizational directories.
- Skill mutations use the skill-specific RPC methods rather than composing generic document calls in
  the client. Each operation validates the manifest and applies all storage changes atomically.
- Renaming or moving a non-root skill operates on its complete directory, preserving supporting
  files. Destination conflicts fail rather than overwrite existing documents.
- A root-level `SKILL.md` is supported, but it has no exclusive directory subtree: moving, renaming,
  or deleting it affects only that manifest. Treating every other root document as its support file
  would risk moving or deleting unrelated skills and documents.
- A destination must be the collection root or an existing legacy directory outside every skill
  bundle. Skills cannot be nested inside other skills, even if an RPC caller supplies a path the UI
  would not offer.

## Permissions and sources

Collection actions follow `getContextCollectionPermissions`. Skill and directory actions are offered
only when the account can edit the collection and the collection is web-backed. Git-backed
collections remain read-only at the skill level, but editors, owners, and admins can still edit
their collection settings, manage Git tokens, and refresh them. Sharing is offered on editable
private collections, and deleting the whole collection only to owners and admins. Viewers keep
navigation, previews, downloads, and opening the collection. Otherwise read-only collections expose
no mutation actions and are not offered as Add Skill targets. If loading a collection's documents
or permissions fails, that collection fails closed as non-writable in the current view.

Collection labels come from the viewer's live membership: deployment-public collections show
Organization, an owned collection shows Private or, once anyone else can read it, Shared, and a
collection someone else shared shows Shared with you and the viewer's role. Collection titles need
not be unique. Labels describe access, not identity: same-titled collections can also have identical
labels. UI selection and API operations use collection IDs rather than titles.

## Sharing

The Share dialog adds people through the Workshop's host-owned person picker
(`useSelectUsers()` in `bridge.ts`). Each picker session gets its own receiver that fixes the
collection and the role chosen when the picker opened, and shares with each picked person as soon as
they are delivered; a backend refusal rejects that delivery, so the picker shows the message in a
status notice that names the person. Cancelling the picker does not undo shares already delivered.
Stopping the wait is not a sharing error and does not undo a delivery already running. The dialog
reloads sharing and permissions when the picker closes and again when a late delivery settles,
including rejected deliveries that may have committed a grant before cleanup failed. A delivery that
settles after the Share dialog closes also refreshes the parent collection metadata or listing.

Mutation controls remain disabled until refreshed sharing and permissions arrive together. If that
reload fails, the previous rows remain visible for context but cannot be used to mutate access;
**Retry** must successfully refresh them first. Backend cleanup errors remain visible independently
of reload failures.

`Share “<collection title>”` starts with an **Add users with role** dropdown and **Select users**
button. Compact access rows show the current account as **You** with a generic profile icon, then
**Anyone in organization** (No access or Can view), then a dashed divider and the other members.
The add-users role and access controls use ghost-button dropdown menus with right-aligned selection
checkmarks; member menus contain role changes and a separate destructive **Remove access** action,
or **Leave collection** for the current account. The last owner cannot leave or be demoted. A neutral
**Done** button is the only footer action and stays visible while the member list scrolls. The
Workshop's person picker uses the same neutral **Done** action.

Anyone a collection was shared with as a viewer or editor can leave it from the collection's row menu,
including viewers, who cannot open the Share dialog. Owners leave from the Share dialog, which knows
whether another owner remains. Both surfaces open the same confirmation before leaving. It warns
that the last member leaving an ownerless collection permanently deletes the collection and its
documents, even when organization-wide viewing is enabled. Leaving reconciles the parent even if
Git token cleanup rejects after the membership was removed, while retaining the cleanup error rather
than presenting a rejected operation as success.

The server remains the authority for every mutation. The client-side checks control affordances and
provide earlier feedback; they are not the security boundary.

## Move limitations

Drag-and-drop is intentionally limited to one collection. Within that collection, existing legacy
directories remain valid destinations for the compatibility reasons above. A same-collection move
can update the skill directory and all supporting documents in one Durable Object storage
transaction.

Cross-collection moves are disabled. Implementing one as separate client-side copy and delete calls
could overwrite concurrent edits or leave duplicated or partially moved data after a failure. A
future backend operation must authorize both collections, reject read-only sources and destinations,
preserve the complete skill subtree, fail on destination conflicts, and define recoverable or atomic
semantics across the two collection Durable Objects before the UI enables these drops.

## Upload limitations

The Skills Navigator accepts standalone Markdown files and folders. Each loose `.md` or `.markdown`
file becomes one skill. A `SKILL.md` file defines a bundle and imports the other files below its source
directory as related skill files; nested bundles are imported as separate top-level skills. Browser
folder selection is based on the non-standard but widely supported `webkitdirectory` input. Chrome's
directory APIs fail or terminate the management app's opaque-origin iframe, so complete folders should
be selected with the folder picker. Supporting folder drops requires reading them in the Workshop host
and passing the files into the sandboxed app.

Uploaded manifests are created through the skill-specific RPC, and supporting files are written only
after the manifest succeeds. If one of those writes fails, the user is told which skill was only
partially uploaded, but the created manifest and any successful related files remain. The collection
Durable Object's `createContextSkillBundle` writes a complete bundle in one transaction (see
[Directory import](#directory-import)); uploads do not use it yet, because the management API would
first need a client-facing bundle method with its own size limits.

## Skill upload format contract

The upload dialog accepts [Agent Skills](https://agentskills.io/specification) and
legacy Markdown. Import acceptance is deliberately broader than validation of the
stored `SKILL.md`.

### Recognizing metadata

An import opts into skill metadata only when it begins with a complete `---`
fenced block that parses as a YAML mapping containing `name` or `description`.
The delimiter must be unindented; a BOM, CRLF, and trailing fence whitespace are
accepted. Indented delimiters within YAML block scalars do not close the block.

Everything else is legacy Markdown, including ordinary text, horizontal rules,
unclosed fences, invalid YAML, sequences, and mappings without skill metadata keys.
These inputs are ambiguous, so preserve the entire source as instruction text
rather than guessing which part to discard. This also applies to imports named
`SKILL.md`; that filename groups supporting files but does not require a legacy
import to already be a valid skill.

### Review and conversion

- Recognized metadata supplies the editable name and description. Missing or
  non-string fields are left blank for correction; invalid strings are not replaced
  with inferred defaults. Extra metadata is retained when writing the manifest.
- Legacy Markdown gets a filename-derived name and a suggested description for
  user review. Conversion adds new frontmatter and preserves the entire original
  instruction text, including leading whitespace and line endings.
- Recognized frontmatter is serialized after edits, but its Markdown body is
  preserved verbatim. The metadata syntax itself need not round-trip byte-for-byte.
- The existing review form checks the final name and description before upload;
  the server's `parseSkillManifest` validates the resulting stored manifest.

`readSkillUploadSource` in `src/skill-manifest-source.ts` is the single recognition
decision used by upload inference and conversion and by directory imports. New import
behavior should be expressed there and covered by the table-driven round-trip tests,
rather than added as an independent delimiter heuristic in a caller.

This is not a claim of full specification validation: the existing server validates
required fields, permits names differing from the parent directory, and does not
validate every optional specification field.

## Directory import

**Browse skills.sh**, in the Add menu or under a search that has two or more characters, searches the
[skills.sh](https://skills.sh) directory, previews a listed skill, and imports it with its supporting
files as a new, ordinary skill: once imported it is edited, renamed, moved and deleted like any other.

### Contract

The management API has three methods, validated by `capnweb-validate` like the rest of `ContextApi`:

- `searchSkillDirectory(query)` calls `GET https://skills.sh/api/search?q=…` (at least two
  characters). Results carry the name, the `owner/repo` source and the install count. A source that is
  not a GitHub repository (skills.sh also lists skills hosted elsewhere, such as `docs.stripe.com`) is
  listed with `importable: false` and cannot be previewed.
- `previewDirectorySkill(source, skillId)` reads the repository's default branch and returns the
  commit SHA it read, the skill's directory in the repository, the manifest's name, description and
  instructions, every file it would import with sizes, the files it leaves out and why, and
  `blockers`: reasons the import would be refused. Nothing is stored.
- `importDirectorySkill(collectionId, source, skillId, commitSha, { name? })` imports exactly
  `commitSha`, so what is stored is what was previewed. It reads the default branch afresh, which
  must still be at `commitSha`; if the skill changed after the preview, the import is refused and the
  skill must be previewed again. The skill goes to `<name>/SKILL.md` at the collection root; `name`
  defaults to the preview's `suggestedName`, the skill id.

skills.sh has no content API, so files come from GitHub. The skill's directory is found with the
rules of the skills CLI that skills.sh is built around (`npx skills add`, vercel-labs/skills): its
priority directories (`skills/`, `skills/.curated/`, agent directories such as `.claude/skills/`, and
any `skills.sh.json` `paths`) before a search at most five levels deep; a directory named after the
skill id narrows the choice, then the frontmatter `name`, slugged as skills.sh slugs it, decides. A
root-level `SKILL.md` imports alone, as the CLI installs it, not with the whole repository.

### Permissions and conflicts

Importing follows the rules for creating a skill, checked before anything is fetched: the account
must be able to edit the collection (deployment admins only, for public collections) and the
collection must be web-backed. The picker lists only those collections, and the server enforces it.
Searching and previewing need no collection.

An import never overwrites. It fails when another skill in the collection already has the name,
including one in a legacy directory, or when anything already exists at `<name>/`. The preview flags a
conflict in the chosen collection so the name can be changed first.

### The atomic bundle RPC

`ContextCollectionDurableObject.createContextSkillBundle(directory, files)` validates the manifest and
every path, refuses a nested `SKILL.md`, an occupied directory and a duplicate skill name, then writes
every document in one storage transaction, building and size-checking each record inside it: any
failure, including one on the last file, leaves nothing behind.

### Provenance

The stored manifest is the published one with `name` set to the chosen name and these entries merged
into its frontmatter `metadata` map, which the Agent Skills specification reserves for client-defined
string properties; the instructions after the frontmatter are kept byte for byte.

```yaml
metadata:
  imported-from: skills.sh
  skills-sh-id: anthropics/skills/frontend-design
  source-repository: https://github.com/anthropics/skills
  source-path: skills/frontend-design   # "." for a root-level SKILL.md
  source-commit: 2c5958ecac7cee2b583967a2c4981d0f4a75c579
  imported-at: "2026-11-09T13:40:00.000Z"
```

These are what an "update from source" action would read; there is no such action yet.

### Limits

At most 200 files, 1 MB per file and 5 MB in total per skill. A larger file is left out and listed;
more files or bytes block the import. Text is stored as text; binary files are kept as bytes, with
their extension's type or `application/octet-stream`, as uploads store them. Symbolic links, Git
submodules, nested skills (import them separately) and the files the skills CLI excludes
(`metadata.json`, `.git/`, `__pycache__/`) are left out and listed. A repository archive is limited
to 64 MB compressed and 256 MB expanded.

### Security model

Fetched content is untrusted, and is stored only on an explicit import after a preview. The preview
says that a skill is instructions agents will follow.

The module that talks to skills.sh and GitHub, `src/skill-directory/`, depends on nothing in Context.
It builds URLs only for fixed hosts (`skills.sh`, `codeload.github.com`, and `api.github.com` when a
token is set) from components validated against strict patterns: `owner` and `repo` against GitHub's
name rules, the skill id against the slug pattern, the commit against 40 hexadecimal characters. A
crafted `source` cannot name another host or path. Redirects are followed by hand: search may move to
`www.skills.sh`, and a renamed repository's metadata within `api.github.com`; archive requests follow
none, and credentials are dropped whenever the host changes. Every request has a timeout. An archive
path that is absolute or contains `..` fails the whole import, and paths are confined to the skill's
directory.

Only public repositories are ever read, whatever the configuration, so no account can use the
deployment to read a repository it could not read itself:

- Without `GITHUB_TOKEN`, archive requests are anonymous, and GitHub serves anonymous archive
  requests for public repositories only.
- With it, the token is used only to raise rate limits. Because codeload honours a token for any
  repository it can read, the repository's metadata (`GET /repos/{owner}/{repo}`, under the token)
  must say `private: false` and `visibility: "public"` before its archive is requested, under the
  canonical name that check returned, and again once the archive has been read. A private, internal
  or missing repository is refused with "Only public GitHub repositories can be imported", and its
  archive is never requested with the token.
- Only a repository's default branch is downloaded; a commit is never fetched by SHA, which could
  return a commit from elsewhere in the repository's fork network. The commit comes from the
  archive's own pax header. An import reads the default branch afresh, re-running the public check,
  and refuses unless it is still at the previewed commit.

The management app runs in an opaque-origin sandbox, so every directory request goes through these
server methods. Successful imports are logged as `context.skill.directory.imported` with the source,
skill id, commit, collection and file count, never content.

### Rate limits and caching

Archives come from `codeload.github.com` as one gzipped tarball per repository, which is not subject
to GitHub's 60-requests-an-hour limit for unauthenticated REST calls, a limit Workers would share
across egress IPs. Should anonymous archive downloads be throttled anyway, an optional `GITHUB_TOKEN`
secret on the Context Worker downloads them under a token's limits, at the cost of two metadata
requests per download for the public check. It must be a fine-grained personal access token with
"Public repositories (read-only)" access and no private repositories; the public check refuses
private repositories even so, but a token that cannot read them is the first line of defence.

Each isolate caches search results for a minute, the commit a repository's default branch was at for
a minute, and up to 24 MB of archives by repository and commit, all from public repositories only. A
preview reads one download for both passes over the archive; an import downloads the default branch
again to confirm it.

