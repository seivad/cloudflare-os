// Speech to text and text to speech for a signed-in user: the models offered, and one call of
// each through the deployment's AI Gateway. The Workshop's chat composer, its read-aloud and its
// conversation mode use them, and so do gadgets, through the host page (a gadget's frame can
// neither record nor reach the network).
//
// Every model runs over the WORKERS_AI binding on the deployment's gateway, with the user and
// `source: "voice"` in the gateway metadata. Workers AI models answer in the call: Whisper with
// `{ text }`, Aura with an MP3 stream, MeloTTS with base64 WAV. A model of AI Gateway's catalog
// answers `{ state: "Completed", result: { text } }` for speech to text and a short-lived link to
// the file for text to speech, which is fetched here. Each shape and timing was measured on
// 2026-11-17 (Aura 2 about 2 s for a sentence, Aura 1 and MeloTTS under 1 s, OpenAI TTS-1 and
// Grok TTS about 2.5 s, Whisper about 1 s for a short recording).

import {
  MAX_SPEAK_CHARS, MAX_VOICE_AUDIO_BYTES,
  type SpeakOptions, type TranscribeOptions, type VoiceModelInfo, type VoiceSpeech, type VoiceTranscript,
} from "@gadgets/workshop-shared/api";
import {
  AiGatewayLogRetryableError, deploymentLogRoute, getAiGatewayConfig, getAiGatewayLog,
  type AiGatewayConfig, type AiGatewayLogRecord, type AiGatewayLogRoute,
} from "./ai-gateway.js";
import type { CostEntry } from "./cost-ledger.js";

/**
 * What a voice call ran as, for counting its cost on the user's own ledger: the gateway log the
 * call was made under, if the binding reported one. Internal: the client never gets it.
 */
export type VoiceCost = { kind: "transcription" | "speech"; model: string; gatewayLogId?: string };

/** A transcript, and what it cost (see VoiceCost). */
export type TranscribeResult = VoiceTranscript & { cost: VoiceCost };
/** A spoken text, and what it cost (see VoiceCost). */
export type SpeakResult = VoiceSpeech & { cost: VoiceCost };

/** How many times a voice call's log is read before its cost is given up on, as the Overseer does for a chat request. */
const VOICE_LOG_ATTEMPTS = 4;

/**
 * The cost a voice call's AI Gateway log gives, as an entry for the user's own ledger. Reads the
 * log up to VOICE_LOG_ATTEMPTS times, waiting 1, 2 then 4 seconds between reads while the gateway
 * says the log is not ready. Voice has no estimate: with no log id or no readable log the result
 * is undefined and nothing is counted.
 */
export async function voiceCostEntry(
  env: Cloudflare.Env, cost: VoiceCost,
  readLog: (env: Cloudflare.Env, route: AiGatewayLogRoute, logId: string) => Promise<AiGatewayLogRecord> = getAiGatewayLog,
  wait: (ms: number) => Promise<void> = (ms) => scheduler.wait(ms),
): Promise<(CostEntry & { source: "voice" }) | undefined> {
  const route = deploymentLogRoute(env);
  if (!cost.gatewayLogId || !route) return undefined;
  for (let attempt = 0; ; ++attempt) {
    try {
      const log = await readLog(env, route, cost.gatewayLogId);
      return { kind: cost.kind, model: cost.model, estimated: false, usd: log.cost, source: "voice" };
    } catch (error) {
      if (!(error instanceof AiGatewayLogRetryableError) || attempt === VOICE_LOG_ATTEMPTS - 1) throw error;
      await wait(1000 * 2 ** attempt);
    }
  }
}

/** One model: what a person sees of it, and how a request becomes its input. */
type VoiceModel = VoiceModelInfo & {
  /** The model's own input for a recording (base64) or a text, and a voice. */
  input(args: { audio?: Uint8Array; contentType?: string; text?: string; voice?: string; language?: string }): Record<string, unknown>;
  /** The recording types the model takes, by MIME type prefix. Absent: any. */
  accepts?: string[];
};

const AURA_2_VOICES = [
  "luna", "asteria", "athena", "aurora", "callista", "cora", "cordelia", "delia", "electra",
  "harmonia", "helena", "hera", "iris", "juno", "minerva", "ophelia", "pandora", "phoebe", "thalia",
  "theia", "vesta", "amalthea", "andromeda", "apollo", "arcas", "aries", "atlas", "draco", "hermes",
  "hyperion", "janus", "jupiter", "mars", "neptune", "odysseus", "orion", "orpheus", "pluto",
  "saturn", "zeus",
];
const AURA_1_VOICES = ["asteria", "luna", "stella", "athena", "hera", "orion", "arcas", "perseus", "angus", "orpheus", "helios", "zeus"];
const MELO_LANGUAGES: Record<string, string> = { en: "English", es: "Spanish", fr: "French", zh: "Chinese", jp: "Japanese", kr: "Korean" };
const OPENAI_VOICES = ["nova", "alloy", "echo", "fable", "onyx", "shimmer"];
const GROK_VOICES = ["eve", "ara", "rex", "sal", "leo"];
const ELEVEN_VOICES: Record<string, string> = { george: "JBFqnCBsd6RMkjVDRZzb" };

const named = (ids: string[]) => ids.map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));

/** Base64 of bytes, in pieces small enough for String.fromCharCode's argument list. */
function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 3 * 8192) out += btoa(String.fromCharCode(...bytes.subarray(i, i + 3 * 8192)));
  return out;
}

/**
 * The models, defaults first of their kind. Deepgram Nova 3 is left out: it takes its recording as
 * a stream, which AI Gateway refuses ("does not support ReadableStreams yet"). ElevenLabs Flash
 * v2.5 answered "Invalid User Credentials" on Unified Billing.
 */
const MODELS: readonly VoiceModel[] = [
  {
    id: "@cf/openai/whisper-large-v3-turbo", name: "Whisper Large v3 Turbo", kind: "transcribe", billing: "workers-ai", isDefault: true,
    priceNote: "about US$0.0005 a minute",
    input: ({ audio, language }) => ({ audio: base64(audio!), ...(language ? { language } : {}), vad_filter: true }),
  },
  {
    id: "openai/gpt-4o-transcribe", name: "GPT-4o Transcribe (Unified)", kind: "transcribe", billing: "unified",
    priceNote: "US$0.006 a minute",
    // An MP4 recording (Safari's) was refused with "User Input Error"; WebM was taken.
    accepts: ["audio/webm", "audio/ogg", "audio/wav", "audio/mpeg", "audio/mp3"],
    input: ({ audio, contentType, language }) => ({ file: `data:${contentType};base64,${base64(audio!)}`, ...(language ? { language } : {}) }),
  },
  {
    id: "@cf/deepgram/aura-2-en", name: "Deepgram Aura 2", kind: "speak", billing: "workers-ai", isDefault: true,
    voices: named(AURA_2_VOICES), defaultVoice: "luna", priceNote: "US$0.03 per 1,000 characters",
    input: ({ text, voice }) => ({ text, speaker: voice, encoding: "mp3" }),
  },
  {
    id: "@cf/deepgram/aura-1", name: "Deepgram Aura 1 (fastest)", kind: "speak", billing: "workers-ai",
    voices: named(AURA_1_VOICES), defaultVoice: "asteria", priceNote: "US$0.015 per 1,000 characters",
    input: ({ text, voice }) => ({ text, speaker: voice, encoding: "mp3" }),
  },
  {
    id: "@cf/myshell-ai/melotts", name: "MeloTTS (multilingual)", kind: "speak", billing: "workers-ai",
    voices: Object.entries(MELO_LANGUAGES).map(([id, name]) => ({ id, name })), defaultVoice: "en", priceNote: "about US$0.0002 a minute",
    input: ({ text, voice }) => ({ prompt: text, lang: voice }),
  },
  {
    id: "openai/tts-1", name: "OpenAI TTS-1 (Unified)", kind: "speak", billing: "unified",
    voices: named(OPENAI_VOICES), defaultVoice: "nova", priceNote: "US$0.015 per 1,000 characters",
    input: ({ text, voice }) => ({ text, voice, response_format: "mp3" }),
  },
  {
    id: "xai/grok-tts", name: "Grok TTS (Unified)", kind: "speak", billing: "unified",
    voices: named(GROK_VOICES), defaultVoice: "eve", priceNote: "US$0.015 per 1,000 characters",
    input: ({ text, voice }) => ({ text, voice_id: voice, language: "auto" }),
  },
  {
    id: "elevenlabs/eleven-v3", name: "ElevenLabs v3 (Unified)", kind: "speak", billing: "unified",
    voices: named(Object.keys(ELEVEN_VOICES)), defaultVoice: "george", priceNote: "US$0.10 per 1,000 characters",
    input: ({ text, voice }) => ({ text, voice_id: ELEVEN_VOICES[voice!], output_format: "mp3_44100_128" }),
  },
];

/** The Workers AI binding's `run`, and the id of the gateway log of the call it made last. */
type AiRun = { run(model: string, input: unknown, options: unknown): Promise<unknown>; aiGatewayLogId?: string | null };

/** The gateway and binding a voice request runs through, or a refusal naming why there is none. */
function gatewayOf(env: Cloudflare.Env): { gw: AiGatewayConfig; ai: AiRun } {
  const gw = getAiGatewayConfig(env);
  if (!gw?.binding) throw new Error("Voice needs this deployment's AI Gateway over its Workers AI binding, and it has none.");
  return { gw, ai: gw.binding as unknown as AiRun };
}

/**
 * The models `userId` may use. A user the deployment's dynamic route budgets (CF_AI_GATEWAY_ROUTE)
 * gets the Workers AI ones only: a route takes chat requests alone, so it could not count what a
 * catalog voice model costs against their budget.
 */
function modelsFor(gw: AiGatewayConfig, userId: string): readonly VoiceModel[] {
  return gw.routedDomain(userId) === undefined ? MODELS : MODELS.filter((m) => m.billing === "workers-ai");
}

function info({ input: _input, accepts: _accepts, ...model }: VoiceModel): VoiceModelInfo {
  return { ...model, ...(model.voices ? { voices: model.voices.map((v) => ({ ...v })) } : {}) };
}

/** The models offered to `userId`, as a picker shows them. Empty with no gateway. */
export function listVoiceModels(env: Cloudflare.Env, userId: string): VoiceModelInfo[] {
  const gw = getAiGatewayConfig(env);
  return gw?.binding ? modelsFor(gw, userId).map(info) : [];
}

function pick(models: readonly VoiceModel[], kind: VoiceModelInfo["kind"], id: string | undefined): VoiceModel {
  if (id === undefined || id === "") return models.find((m) => m.kind === kind && m.isDefault) ?? models.find((m) => m.kind === kind)!;
  const model = models.find((m) => m.id === id && m.kind === kind);
  if (!model) throw new Error(`No ${kind === "speak" ? "text-to-speech" : "speech-to-text"} model ${JSON.stringify(id.slice(0, 80))} is offered to you.`);
  return model;
}

const metadata = (userId: string) => ({ user: userId, source: "voice" });

/** The text of a recording. See `AuthenticatedApi.transcribe`. */
export async function transcribe(env: Cloudflare.Env, userId: string, audio: Uint8Array, contentType: string, options: TranscribeOptions = {}): Promise<TranscribeResult> {
  const { gw, ai } = gatewayOf(env);
  if (!(audio instanceof Uint8Array) || audio.byteLength === 0) throw new Error("The recording is empty.");
  if (audio.byteLength > MAX_VOICE_AUDIO_BYTES) throw new Error(`The recording is larger than ${MAX_VOICE_AUDIO_BYTES / (1024 * 1024)} MB. Record a shorter piece.`);
  const type = String(contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type.startsWith("audio/") && type !== "video/webm") throw new Error("The recording must be audio.");
  const language = typeof options.language === "string" && /^[a-z]{2}$/.test(options.language) ? options.language : undefined;
  const models = modelsFor(gw, userId);
  let model = pick(models, "transcribe", options.model);
  // A model that takes no recording of this type gives way to the default, which takes any.
  if (model.accepts && !model.accepts.some((a) => type.startsWith(a))) model = pick(models, "transcribe", undefined);
  const answer = await ai.run(model.id, model.input({ audio, contentType: type === "video/webm" ? "audio/webm" : type, language }), { gateway: { id: gw.gateway, metadata: metadata(userId) } });
  const cost: VoiceCost = { kind: "transcription", model: model.id, gatewayLogId: ai.aiGatewayLogId ?? undefined };
  const result = answer as { text?: unknown; result?: { text?: unknown } } | null;
  const text = result?.text ?? result?.result?.text;
  if (typeof text !== "string") throw new Error(`${model.name} answered without a transcript.`);
  return { text: text.trim(), model: model.id, cost };
}

/** Text as spoken audio. See `AuthenticatedApi.speak`. */
export async function speak(env: Cloudflare.Env, userId: string, text: string, options: SpeakOptions = {}, fetcher: typeof fetch = fetch): Promise<SpeakResult> {
  const { gw, ai } = gatewayOf(env);
  const said = typeof text === "string" ? text.trim() : "";
  if (!said) throw new Error("There is no text to speak.");
  if (said.length > MAX_SPEAK_CHARS) throw new Error(`At most ${MAX_SPEAK_CHARS} characters are spoken at once; speak a longer text in parts.`);
  const model = pick(modelsFor(gw, userId), "speak", options.model);
  const voice = options.voice && model.voices?.some((v) => v.id === options.voice) ? options.voice : model.defaultVoice;
  const answer = await ai.run(model.id, model.input({ text: said, voice }), { gateway: { id: gw.gateway, metadata: metadata(userId) } });
  const cost: VoiceCost = { kind: "speech", model: model.id, gatewayLogId: ai.aiGatewayLogId ?? undefined };
  if (answer instanceof ReadableStream) {
    return { audio: new Uint8Array(await new Response(answer).arrayBuffer()), contentType: "audio/mpeg", model: model.id, cost };
  }
  const shaped = answer as { audio?: unknown; result?: { audio?: unknown } } | null;
  if (typeof shaped?.audio === "string") {
    return { audio: Uint8Array.from(atob(shaped.audio), (c) => c.charCodeAt(0)), contentType: "audio/wav", model: model.id, cost };
  }
  const url = shaped?.result?.audio;
  if (typeof url === "string" && url.startsWith("https://")) {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`${model.name}'s audio could not be fetched (HTTP ${response.status}).`);
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
    return { audio: new Uint8Array(await response.arrayBuffer()), contentType: type.startsWith("audio/") ? type : "audio/mpeg", model: model.id, cost };
  }
  throw new Error(`${model.name} answered without audio.`);
}
