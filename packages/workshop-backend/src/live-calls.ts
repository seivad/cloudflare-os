// Gadgets' live calls (see docs/live-calls.md): one RealtimeKit meeting per gadget, open to
// exactly the people who hold the gadget. The Overseer owns one LiveCalls, which issues tickets
// (RealtimeKit participant tokens) to holders and revokes them -- by deleting the participant,
// which also removes them from the live session -- whenever someone loses the gadget.

import type { AiChatAuthorInfo, AffectedCollaborator, CallInvite, CallRosterEntry, CallTicket,
    CollaboratorAccess, WorkpieceId } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability";
import { RealtimeKitApi, type LiveParticipant } from "./realtime-kit";
import { accessIncludesGadget } from "./sharing";
import type { CallParticipantRecord, OverseerStorage } from "./storage-schema/overseer-storage";

const logger = createWorkshopLogger("workshop.live-calls");

/** How long a ticket admits new connections. A connection already made outlives it. */
export const CALL_TICKET_TTL_MS = 4 * 60 * 60 * 1000;

/** How long one gadget's roster is reused, so N viewers cost about one lookup per interval. */
export const CALL_ROSTER_CACHE_MS = 10_000;

/** The least time between two invitations from one person to another to one gadget's call. */
export const CALL_INVITE_INTERVAL_MS = 20_000;

// How long cleanup RealtimeKit keeps refusing is retried before it is abandoned (and logged as an
// error). By then every ticket this Workshop issued for it has expired; see docs/live-calls.md.
const CLEANUP_ABANDON_MS = 24 * 60 * 60 * 1000;

const UNAVAILABLE = "Live calls are not available: this deployment has no RealtimeKit app configured.";

/** What LiveCalls needs of the Overseer. */
export type LiveCallsHost = {
  storage: Pick<OverseerStorage, "callMeetings" | "callParticipants" | "callCleanup" | "deleting" |
      "title" | "containsRestrictedData" | "gadgets">;
  ctx: {id: {toString(): string}, waitUntil(promise: Promise<unknown>): void};
  getSharingManager(): Promise<{getEffectiveAccess(profileId: string): CollaboratorAccess | undefined}>;
  isShareableGadget(gadgetId: WorkpieceId): boolean;
  /** Re-arms the Overseer's alarm, which retries cleanupDue() work through deliverCleanup(). */
  scheduleLiveCallCleanup(): void;
  /** Tells `profileId`'s open tabs about `invite` (UserDurableObject.notifyCallInvite). */
  deliverCallInvite(profileId: string, invite: CallInvite): Promise<void>;
};

/** Who is asking: their User DO id, and a way to read their own profile from it. */
export type CallCaller = {
  userId: string;
  profile: () => Promise<AiChatAuthorInfo>;
};

export class LiveCalls {
  // Each gadget's last roster lookup, while fresh enough to reuse (see CALL_ROSTER_CACHE_MS).
  #rosters = new Map<WorkpieceId, {at: number, meetingId: string, live: Promise<LiveParticipant[]>}>();
  // Serializes meeting creation per gadget, and participant creation per person per gadget, so
  // concurrent joins create one of each. In memory only: storage is re-read after every await.
  #locks = new Map<string, Promise<unknown>>();
  // When each (inviter, invitee, gadget) invitation was last sent.
  #invitesSent = new Map<string, number>();
  #cleanupRetryAt = 0;
  #cleanupDrain?: Promise<void>;

  #logger: typeof logger;

  /** `api` is null when the deployment has no RealtimeKit app, which makes every call refuse. */
  constructor(private host: LiveCallsHost, private api: RealtimeKitApi | null) {
    this.#logger = logger.with({gadgetId: host.ctx.id.toString()});
  }

  /** Whether live calls are configured on this deployment. */
  get available(): boolean {
    return this.api !== null;
  }

  #requireApi(): RealtimeKitApi {
    if (!this.api) throw new Error(UNAVAILABLE);
    return this.api;
  }

  // Whether `profileId` holds `gadgetId` right now, by live access: refused, like an open, once
  // the workspace is being deleted or the gadget is gone or still provisional to a chat.
  #holds(access: CollaboratorAccess | undefined, gadgetId: WorkpieceId): boolean {
    return !this.host.storage.deleting.get() && this.host.isShareableGadget(gadgetId) &&
        access !== undefined && accessIncludesGadget(access, gadgetId);
  }

  /**
   * Issue `caller` a ticket to `gadgetId`'s call. The caller holds the gadget's capability, but
   * their live access is checked as well, both before and after each RealtimeKit round trip: a
   * ticket must not outlive the access that earned it, and the capability itself only dies with
   * the restart that follows a revocation, ~100ms later.
   */
  async join(gadgetId: WorkpieceId, caller: CallCaller): Promise<CallTicket> {
    let api = this.#requireApi();
    let [sharing, profile] = await Promise.all([this.host.getSharingManager(), caller.profile()]);
    let holds = () => this.#holds(sharing.getEffectiveAccess(profile.id), gadgetId);
    let refuse = () => new Error(`No such gadget: ${gadgetId}`);
    if (!holds()) throw refuse();

    await api.ensurePreset();
    let meetingId = await this.#ensureMeeting(api, gadgetId);
    let name = profile.name.trim() || profile.id.split("@")[0];
    let expiresAt = new Date(Date.now() + CALL_TICKET_TTL_MS);
    let key = participantKey(gadgetId, caller.userId);

    return await this.#withLock(`participant:${key}`, async () => {
      let existing = this.host.storage.callParticipants.get(key);
      if (existing && existing.meetingId !== meetingId) {
        this.#retire([existing]);
        existing = undefined;
      }
      if (existing) {
        let refreshed = await api.refreshToken(meetingId, existing.participantId, expiresAt);
        if (!holds() || this.host.storage.callParticipants.get(key)?.participantId !== existing.participantId) {
          // A revocation landed meanwhile and has already retired this participant (or retires it
          // now), which revokes the token just minted.
          this.#retire([existing]);
          throw refuse();
        }
        if (refreshed) {
          return {authToken: refreshed.token, expiresAt: refreshed.expiresAt, displayName: existing.name};
        }
        // RealtimeKit no longer has the participant; add them afresh.
        this.host.storage.callParticipants.delete(key);
      }

      let added = await api.addParticipant(meetingId, {customParticipantId: caller.userId, name, expiresAt});
      let record: CallParticipantRecord = {
        gadgetId, userId: caller.userId, profileId: profile.id, meetingId,
        participantId: added.participantId, name,
      };
      if (!holds() || this.host.storage.callMeetings.get(gadgetId)?.meetingId !== meetingId) {
        // Lost the gadget, or its call was closed, while the participant was being added: no
        // ticket is issued, and the participant must not outlive that.
        this.#retire([record]);
        throw refuse();
      }
      this.host.storage.callParticipants.put(record);
      return {authToken: added.token, expiresAt: added.expiresAt, displayName: name};
    });
  }

  async #ensureMeeting(api: RealtimeKitApi, gadgetId: WorkpieceId): Promise<string> {
    let existing = this.host.storage.callMeetings.get(gadgetId);
    if (existing) return existing.meetingId;
    return await this.#withLock(`meeting:${gadgetId}`, async () => {
      let created = this.host.storage.callMeetings.get(gadgetId);
      if (created) return created.meetingId;
      let meetingId = await api.createMeeting();
      if (this.host.storage.deleting.get() || !this.host.isShareableGadget(gadgetId)) {
        this.#journal([{meetingId}]);
        throw new Error(`No such gadget: ${gadgetId}`);
      }
      this.host.storage.callMeetings.put({gadgetId, meetingId});
      this.#logger.info("created live call", {event: "live_call.meeting.created"});
      return meetingId;
    });
  }

  /**
   * Who is in `gadgetId`'s call now, in join order. The lookup is shared for CALL_ROSTER_CACHE_MS,
   * but each person is matched against the participants stored now, so someone whose ticket was
   * revoked drops out at once.
   */
  async roster(gadgetId: WorkpieceId): Promise<CallRosterEntry[]> {
    let api = this.#requireApi();
    if (this.host.storage.deleting.get() || !this.host.isShareableGadget(gadgetId)) {
      throw new Error(`No such gadget: ${gadgetId}`);
    }
    let meeting = this.host.storage.callMeetings.get(gadgetId);
    if (!meeting) return [];
    let cached = this.#rosters.get(gadgetId);
    if (!cached || cached.meetingId !== meeting.meetingId || Date.now() - cached.at >= CALL_ROSTER_CACHE_MS) {
      let live = api.liveParticipants(meeting.meetingId);
      cached = {at: Date.now(), meetingId: meeting.meetingId, live};
      this.#rosters.set(gadgetId, cached);
      live.catch(() => {
        if (this.#rosters.get(gadgetId)?.live === live) this.#rosters.delete(gadgetId);
      });
    }
    let live = await cached.live;
    return live.flatMap(({customParticipantId}) => {
      let record = this.host.storage.callParticipants.get(participantKey(gadgetId, customParticipantId));
      return record ? [{profileId: record.profileId, name: record.name, callParticipantId: record.userId}] : [];
    });
  }

  /**
   * Invite `inviteeProfileId` to `gadgetId`'s call on behalf of `inviter`, who must hold it
   * themselves. Refused unless the invitee holds the gadget too: an invitation grants nothing.
   * Titles are withheld once the workspace holds restricted data, as for a share notification.
   */
  async invite(gadgetId: WorkpieceId, inviter: CallCaller, inviteeProfileId: string): Promise<void> {
    this.#requireApi();
    let [sharing, profile] = await Promise.all([this.host.getSharingManager(), inviter.profile()]);
    if (!this.#holds(sharing.getEffectiveAccess(profile.id), gadgetId)) {
      throw new Error(`No such gadget: ${gadgetId}`);
    }
    if (inviteeProfileId === profile.id) throw new Error("You can't invite yourself.");
    if (!this.#holds(sharing.getEffectiveAccess(inviteeProfileId), gadgetId)) {
      throw new Error("They don't have this gadget yet. Share it with them first.");
    }

    let now = Date.now();
    for (let [key, at] of this.#invitesSent) {
      if (now - at >= CALL_INVITE_INTERVAL_MS) this.#invitesSent.delete(key);
    }
    let rateKey = JSON.stringify([inviter.userId, inviteeProfileId, gadgetId]);
    if (this.#invitesSent.has(rateKey)) {
      throw new Error("They were just invited. Try again in a few seconds.");
    }
    this.#invitesSent.set(rateKey, now);

    let restricted = this.host.storage.containsRestrictedData.get();
    let gadget = this.host.storage.gadgets.get(gadgetId);
    try {
      await this.host.deliverCallInvite(inviteeProfileId, {
        workspaceId: this.host.ctx.id.toString(),
        gadgetId,
        gadgetTitle: restricted ? "" : gadget?.title ?? "",
        inviter: profile,
      });
    } catch (error) {
      // Undelivered, so it may be sent again at once.
      if (this.#invitesSent.get(rateKey) === now) this.#invitesSent.delete(rateKey);
      throw error;
    }
  }

  /**
   * Revoke the tickets of collaborators a sharing change took gadgets from: each of their
   * participants in a call of a gadget their new access lacks is retired (see #retire). Call in
   * the change's synchronous continuation, before anything can restart the Overseer.
   */
  revokeLostAccess(affected: AffectedCollaborator[]): void {
    let lost: CallParticipantRecord[] = [];
    for (let {profile, newAccess} of affected) {
      for (let record of Array.from(this.host.storage.callParticipants.byProfile.get(profile.id))) {
        if (!newAccess || !accessIncludesGadget(newAccess, record.gadgetId)) lost.push(record);
      }
    }
    this.#retire(lost);
  }

  /** Close `gadgetId`'s call for good, as the gadget is being deleted. */
  forgetGadget(gadgetId: WorkpieceId): void {
    let meeting = this.host.storage.callMeetings.get(gadgetId);
    let participants = Array.from(this.host.storage.callParticipants.list({prefix: `${gadgetId}:`}));
    if (!meeting && !participants.length) return;
    this.host.storage.callMeetings.delete(gadgetId);
    this.#retire(participants);
    if (meeting) this.#journal([{meetingId: meeting.meetingId}]);
  }

  /** Close every call in the workspace for good, as the workspace is being deleted. */
  forgetAll(): void {
    let meetings = Array.from(this.host.storage.callMeetings.list());
    let participants = Array.from(this.host.storage.callParticipants.list());
    if (!meetings.length && !participants.length) return;
    for (let meeting of meetings) this.host.storage.callMeetings.delete(meeting.gadgetId);
    this.#retire(participants);
    this.#journal(meetings.map(({meetingId}) => ({meetingId})));
  }

  // Forget participants and journal their deletion, which revokes every token they were issued
  // and removes them from the call. Synchronous, and so atomic with the caller's other writes in
  // the same step: the journal is durable before any restart that step schedules.
  #retire(participants: CallParticipantRecord[]): void {
    if (!participants.length) return;
    for (let record of participants) {
      let stored = this.host.storage.callParticipants.get(participantKey(record.gadgetId, record.userId));
      if (stored?.participantId === record.participantId) {
        this.host.storage.callParticipants.deleteRecord(record);
      }
      this.#rosters.delete(record.gadgetId);
    }
    this.#journal(participants);
  }

  // Record RealtimeKit cleanup still owed -- a participant to delete, or else a meeting to close --
  // and start delivering it. The alarm retries what fails.
  #journal(entries: {meetingId: string, participantId?: string}[]): void {
    if (!entries.length) return;
    let since = Date.now();
    for (let {meetingId, participantId} of entries) {
      let key = participantId ? `participant:${participantId}` : `meeting:${meetingId}`;
      if (this.host.storage.callCleanup.get(key)) continue;
      this.host.storage.callCleanup.put({key, meetingId, ...(participantId ? {participantId} : {}), since});
    }
    this.#cleanupRetryAt = 0;
    this.host.scheduleLiveCallCleanup();
    // After the current synchronous step, so everything it journals goes in one pass.
    this.host.ctx.waitUntil(Promise.resolve().then(() => this.deliverCleanup()));
  }

  /** Whether RealtimeKit cleanup is still owed. */
  hasPendingCleanup(): boolean {
    return [...this.host.storage.callCleanup.list({limit: 1})].length > 0;
  }

  /** When the alarm should next retry owed cleanup, or null if none is owed. */
  cleanupDue(): number | null {
    return this.hasPendingCleanup() ? this.#cleanupRetryAt || Date.now() + 1_000 : null;
  }

  /**
   * Deliver owed RealtimeKit cleanup. Single-flight; what fails stays journaled for the alarm. A
   * deployment no longer configured for live calls can deliver none of it, so it is dropped: the
   * tickets it would revoke expire on their own (CALL_TICKET_TTL_MS).
   */
  deliverCleanup(): Promise<void> {
    if (this.#cleanupDrain) return this.#cleanupDrain;
    if (!this.hasPendingCleanup()) return Promise.resolve();
    this.#cleanupRetryAt = Date.now() + 30_000;
    this.host.scheduleLiveCallCleanup();
    let entries = Array.from(this.host.storage.callCleanup.list());
    return this.#cleanupDrain = (async () => {
      let api = this.api;
      if (!api) {
        for (let entry of entries) this.host.storage.callCleanup.deleteRecord(entry);
        this.#logger.warn("dropped live call cleanup: live calls are no longer configured", {
          event: "live_call.cleanup.dropped", failureCount: entries.length,
        });
        return;
      }
      await Promise.allSettled(entries.map(async entry => {
        try {
          if (entry.participantId) await api.deleteParticipant(entry.meetingId, entry.participantId);
          else await api.deactivateMeeting(entry.meetingId);
          this.host.storage.callCleanup.deleteRecord(entry);
        } catch (error) {
          if (Date.now() - entry.since >= CLEANUP_ABANDON_MS) {
            this.host.storage.callCleanup.deleteRecord(entry);
            this.#logger.error("abandoned live call cleanup", {event: "live_call.cleanup.abandoned", error});
          } else {
            this.#logger.warn("live call cleanup deferred", {event: "live_call.cleanup.deferred", error});
          }
        }
      }));
    })().finally(() => {
      this.#cleanupDrain = undefined;
      // Cleanup journaled during this pass gets a pass of its own now; what failed in this one
      // waits for the alarm.
      let attempted = new Set(entries.map(entry => entry.key));
      if ([...this.host.storage.callCleanup.list()].some(entry => !attempted.has(entry.key))) {
        this.#cleanupRetryAt = 0;
        this.host.ctx.waitUntil(this.deliverCleanup());
      }
      this.host.scheduleLiveCallCleanup();
    });
  }

  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let prior = this.#locks.get(key) ?? Promise.resolve();
    let run = prior.catch(() => {}).then(fn);
    let tail = run.catch(() => {});
    this.#locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }
}

function participantKey(gadgetId: WorkpieceId, userId: string): string {
  return `${gadgetId}:${userId}`;
}
