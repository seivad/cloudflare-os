// A minimal client for the RealtimeKit REST API, which live calls run on (see docs/live-calls.md):
// https://developers.cloudflare.com/api/resources/realtime_kit/
//
// The API token is account-level and can mint a ticket into any of the app's meetings, so it never
// leaves this module: it is not logged, and errors carry only the request, the HTTP status and
// RealtimeKit's error codes. Participant tokens are returned to the caller and never logged here.

/** The deployment's RealtimeKit app, from env; see realtimeKitConfig(). */
export type RealtimeKitConfig = {
  accountId: string;
  appId: string;
  apiToken: string;
};

/**
 * The deployment's RealtimeKit app, or null when live calls are not configured: all three of
 * REALTIMEKIT_ACCOUNT_ID, REALTIMEKIT_APP_ID and REALTIMEKIT_API_TOKEN must be set.
 */
export function realtimeKitConfig(env: Cloudflare.Env): RealtimeKitConfig | null {
  let accountId = env.REALTIMEKIT_ACCOUNT_ID?.trim();
  let appId = env.REALTIMEKIT_APP_ID?.trim();
  let apiToken = env.REALTIMEKIT_API_TOKEN?.trim();
  if (!accountId || !appId || !apiToken) return null;
  return {accountId, appId, apiToken};
}

/** The preset every live-call participant is added with, created by the Workshop if missing. */
export const LIVE_CALL_PRESET = "cf-os-live";

/** A RealtimeKit request that failed. Carries no credentials. */
export class RealtimeKitError extends Error {
  constructor(readonly status: number, request: string, codes: string) {
    super(`RealtimeKit ${request} failed with HTTP ${status}${codes ? ` (${codes})` : ""}.`);
    this.name = "RealtimeKitError";
  }
}

/** One person currently in a meeting's live session. */
export type LiveParticipant = {customParticipantId: string; name: string};

// A group video call and nothing else: no screen share, chat, polls, plugins, recording,
// livestream, transcription or waiting room, nobody hidden, and nobody able to rename themselves
// (names come from Workshop profiles) or act on anyone else. The UI tokens are required by the
// API but unused, since the Workshop draws its own UI with the Core SDK.
const PRESET = {
  name: LIVE_CALL_PRESET,
  config: {
    view_type: "GROUP_CALL",
    max_screenshare_count: 0,
    max_video_streams: {desktop: 12, mobile: 6},
    media: {
      video: {quality: "vga", frame_rate: 24},
      screenshare: {quality: "vga", frame_rate: 5},
    },
  },
  permissions: {
    accept_waiting_requests: false,
    can_accept_production_requests: false,
    can_change_participant_permissions: false,
    can_edit_display_name: false,
    can_livestream: false,
    can_record: false,
    can_spotlight: false,
    disable_participant_audio: false,
    disable_participant_screensharing: false,
    disable_participant_video: false,
    hidden_participant: false,
    kick_participant: false,
    pin_participant: false,
    show_participant_list: true,
    transcription_enabled: false,
    recorder_type: "NONE",
    waiting_room_type: "SKIP",
    media: {
      audio: {can_produce: "ALLOWED"},
      video: {can_produce: "ALLOWED"},
      screenshare: {can_produce: "NOT_ALLOWED"},
    },
    chat: {
      public: {can_send: false, text: false, files: false},
      private: {can_send: false, can_receive: false, text: false, files: false},
    },
    polls: {can_create: false, can_view: false, can_vote: false},
    plugins: {can_start: false, can_close: false, can_edit_config: false, config: {}},
    connected_meetings: {
      can_alter_connected_meetings: false,
      can_switch_connected_meetings: false,
      can_switch_to_parent_meeting: false,
    },
  },
  ui: {
    design_tokens: {
      border_radius: "rounded",
      border_width: "thin",
      spacing_base: 4,
      theme: "dark",
      colors: {
        background: {600: "#222222", 700: "#1f1f1f", 800: "#1b1b1b", 900: "#181818", 1000: "#141414"},
        brand: {300: "#f6821f", 400: "#f6821f", 500: "#f6821f", 600: "#f6821f", 700: "#f6821f"},
        danger: "#ff2d2d", success: "#62bf5a", warning: "#ffcd07",
        text: "#eeeeee", text_on_brand: "#ffffff", video_bg: "#191919",
      },
    },
  },
};

type Envelope<T> = {success?: boolean; data?: T; errors?: {code?: number | string}[]};

/** The RealtimeKit REST calls live calls make, against one app. */
export class RealtimeKitApi {
  #presetReady?: Promise<void>;

  constructor(private config: RealtimeKitConfig, private fetchFn: typeof fetch = fetch) {}

  async #request<T>(method: string, path: string, body?: object): Promise<{status: number, data?: T}> {
    let {accountId, appId, apiToken} = this.config;
    let url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
        `/realtime/kit/${encodeURIComponent(appId)}${path}`;
    let response = await this.fetchFn(url, {
      method,
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        ...(body ? {"Content-Type": "application/json"} : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let envelope = await response.json().catch(() => ({})) as Envelope<T>;
    if (!response.ok || envelope.success === false) {
      // Only the request's shape goes in the message: ids in the path are not secrets, and the
      // body is never echoed.
      let codes = (envelope.errors ?? []).map(error => String(error.code ?? "")).filter(Boolean);
      throw new RealtimeKitError(response.status, `${method} ${path.replace(/\?.*/, "")}`,
          codes.join(", "));
    }
    return {status: response.status, data: envelope.data};
  }

  /**
   * Resolves once the live-call preset exists. Memoized for this client's life; a failure is not,
   * so the next call tries again.
   */
  ensurePreset(): Promise<void> {
    this.#presetReady ??= (async () => {
      if (await this.#hasPreset()) return;
      try {
        await this.#request("POST", "/presets", PRESET);
      } catch (error) {
        // Another Workshop instance may have created it meanwhile.
        if (!await this.#hasPreset()) throw error;
      }
    })().catch(error => {
      this.#presetReady = undefined;
      throw error;
    });
    return this.#presetReady;
  }

  async #hasPreset(): Promise<boolean> {
    let {data} = await this.#request<{name: string}[]>(
        "GET", `/presets?search=${encodeURIComponent(LIVE_CALL_PRESET)}&per_page=100`);
    return (data ?? []).some(preset => preset.name === LIVE_CALL_PRESET);
  }

  /** Create a meeting for one gadget's call, returning its id. Nothing about the gadget is sent. */
  async createMeeting(): Promise<string> {
    let {data} = await this.#request<{id: string}>("POST", "/meetings", {
      title: "Live call",
      record_on_start: false,
      live_stream_on_start: false,
      persist_chat: false,
      summarize_on_end: false,
      transcribe_on_end: false,
    });
    if (!data?.id) throw new RealtimeKitError(200, "POST /meetings", "no meeting id");
    return data.id;
  }

  /**
   * Close a meeting for good: everyone in it is removed and nobody can join again. A meeting
   * RealtimeKit no longer has counts as closed.
   */
  async deactivateMeeting(meetingId: string): Promise<void> {
    await this.#ignoreNotFound(() =>
        this.#request("PATCH", `/meetings/${encodeURIComponent(meetingId)}`, {status: "INACTIVE"}));
  }

  /** Add a participant to a meeting, with a token admitting them until `expiresAt`. */
  async addParticipant(meetingId: string,
      participant: {customParticipantId: string, name: string, expiresAt: Date})
      : Promise<{participantId: string, token: string, expiresAt: Date}> {
    let {data} = await this.#request<{id: string, token: string, expires_on?: string}>(
        "POST", `/meetings/${encodeURIComponent(meetingId)}/participants`, {
          custom_participant_id: participant.customParticipantId,
          preset_name: LIVE_CALL_PRESET,
          name: participant.name,
          token: {expires_on: participant.expiresAt.toISOString()},
        });
    if (!data?.id || !data.token) {
      throw new RealtimeKitError(200, "POST /meetings/:id/participants", "no participant token");
    }
    return {
      participantId: data.id,
      token: data.token,
      expiresAt: data.expires_on ? new Date(data.expires_on) : participant.expiresAt,
    };
  }

  /**
   * Issue another token for an existing participant. Returns null if RealtimeKit no longer has
   * the participant.
   */
  async refreshToken(meetingId: string, participantId: string, expiresAt: Date)
      : Promise<{token: string, expiresAt: Date} | null> {
    let result = await this.#ignoreNotFound(() => this.#request<{token: string, expires_on?: string}>(
        "POST",
        `/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}/token`,
        {expires_on: expiresAt.toISOString()}));
    if (!result) return null;
    if (!result.data?.token) {
      throw new RealtimeKitError(200, "POST /meetings/:id/participants/:id/token", "no token");
    }
    return {
      token: result.data.token,
      expiresAt: result.data.expires_on ? new Date(result.data.expires_on) : expiresAt,
    };
  }

  /**
   * Delete a participant, which revokes every token issued to them and removes them from the
   * meeting's live session. A participant RealtimeKit no longer has counts as deleted.
   */
  async deleteParticipant(meetingId: string, participantId: string): Promise<void> {
    await this.#ignoreNotFound(() => this.#request("DELETE",
        `/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}`));
  }

  /**
   * The people in a meeting's live session right now, in the order they joined, or none when
   * nobody is. Someone in from several tabs is listed once.
   */
  async liveParticipants(meetingId: string): Promise<LiveParticipant[]> {
    let session = await this.#ignoreNotFound(() => this.#request<{id: string, status?: string}>(
        "GET", `/meetings/${encodeURIComponent(meetingId)}/active-session`));
    let sessionId = session?.data?.id;
    if (!sessionId || session?.data?.status === "ENDED") return [];
    let result = await this.#ignoreNotFound(() => this.#request<{participants?: {
      custom_participant_id?: string, display_name?: string, left_at?: string | null,
    }[]}>("GET", `/sessions/${encodeURIComponent(sessionId)}/participants` +
        "?sort_by=joinedAt&sort_order=ASC&per_page=100"));
    let seen = new Set<string>();
    let live: LiveParticipant[] = [];
    for (let entry of result?.data?.participants ?? []) {
      let id = entry.custom_participant_id;
      if (!id || entry.left_at || seen.has(id)) continue;
      seen.add(id);
      live.push({customParticipantId: id, name: entry.display_name ?? ""});
    }
    return live;
  }

  async #ignoreNotFound<T>(request: () => Promise<T>): Promise<T | null> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof RealtimeKitError && error.status === 404) return null;
      throw error;
    }
  }
}
