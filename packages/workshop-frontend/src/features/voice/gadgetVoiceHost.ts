// Voice for a gadget's page. A gadget's frame cannot open the microphone (its origin is opaque)
// and may only play `data:` URLs, so the Workshop page records and speaks on its behalf: the frame
// gets a `voice` global (GadgetUI.tsx's injected code), an RPC stub to this object over its own
// MessagePort.
//
// The frame runs code the agent wrote, perhaps from someone else's blueprint, so everything it
// passes is checked here, listening needs the person's permission each time the gadget's page is
// opened (asked in the Workshop's own UI, not the frame's), and the page shows while it listens.
// Speech is spoken one piece at a time and synthesis is rate-limited, since both spend credits.

import { RpcTarget } from "capnweb";
import { MAX_SPEAK_CHARS, type SpeakOptions, type VoiceModelInfo } from "@gadgets/workshop-shared/api";
import { startRecording, type Recording } from "./recorder";
import type { VoiceApi } from "./VoiceContext";

/** What a gadget passes to `voice.listen()`. */
export type GadgetListenOptions = {
  model?: string;
  language?: string;
  /** End once the speaker pauses (default true); false records until `stopListening()`. */
  untilSilence?: boolean;
  /** The longest recording, 1 to 300 seconds (default 60). */
  maxSeconds?: number;
  /** Called about 20 times a second with the input level, 0 to 1. */
  onLevel?: (level: number) => void;
};

/** What the page hosting a gadget provides to this object. */
export type GadgetVoiceDeps = {
  /** The page's voice now, or null where there is none. */
  voice: () => VoiceApi | null;
  /** Asks the person whether this gadget may use the microphone; resolves with their answer. */
  askToListen: () => Promise<boolean>;
  /** Tells the page the gadget is listening (with how to stop it), or has stopped. */
  setListening: (stop: (() => void) | null) => void;
};

const SYNTHESES_PER_MINUTE = 20;

const optionalString = (value: unknown, name: string, max = 200): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`${name} must be a string.`);
  return value || undefined;
};

/** Base64 of bytes, in pieces small enough for String.fromCharCode's argument list. */
function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 3 * 8192) out += btoa(String.fromCharCode(...bytes.subarray(i, i + 3 * 8192)));
  return out;
}

export class GadgetVoiceHost extends RpcTarget {
  #deps: GadgetVoiceDeps;
  #allowed: boolean | null = null;
  #recording: Recording | null = null;
  #syntheses: number[] = [];
  #disposed = false;

  constructor(deps: GadgetVoiceDeps) {
    super();
    this.#deps = deps;
  }

  #voice(): VoiceApi {
    const voice = this.#deps.voice();
    if (this.#disposed || !voice || voice.models.length === 0) throw new Error("Voice is not available on this page.");
    return voice;
  }

  /** Whether voice can be used: the deployment offers it and the browser can record. */
  available(): boolean {
    return !this.#disposed && (this.#deps.voice()?.available ?? false);
  }

  /** The speech-to-text and text-to-speech models offered, defaults marked. */
  models(): VoiceModelInfo[] {
    return this.#deps.voice()?.models ?? [];
  }

  /**
   * Listens through the Workshop's microphone and answers what was said, or null when nothing
   * was. The person is asked first, once for each time the gadget's page is opened.
   */
  async listen(options: GadgetListenOptions = {}): Promise<{ text: string; model: string } | null> {
    const voice = this.#voice();
    const model = optionalString(options?.model, "model");
    const language = optionalString(options?.language, "language", 8);
    const maxSeconds = options?.maxSeconds === undefined ? 60 : Number(options.maxSeconds);
    if (!Number.isFinite(maxSeconds) || maxSeconds < 1 || maxSeconds > 300) throw new Error("maxSeconds must be between 1 and 300.");
    const onLevel = typeof options?.onLevel === "function" ? options.onLevel : undefined;
    if (this.#recording) throw new Error("Already listening: call stopListening() first.");
    if (this.#allowed === null) this.#allowed = await this.#deps.askToListen();
    if (!this.#allowed) throw new Error("The person did not allow this gadget to use the microphone.");
    voice.stopSpeaking();
    let lastLevelAt = 0;
    const recording = startRecording({
      untilSilence: options?.untilSilence !== false,
      maxMs: maxSeconds * 1000,
      onLevel: onLevel && ((level) => {
        // Every other reading, so a slow frame is not flooded.
        const now = Date.now();
        if (now - lastLevelAt < 90) return;
        lastLevelAt = now;
        void Promise.resolve(onLevel(level)).catch(() => {});
      }),
    });
    this.#recording = recording;
    this.#deps.setListening(() => recording.stop());
    try {
      const recorded = await recording.result;
      if (!recorded || this.#disposed) return null;
      const text = await voice.transcribe(recorded, model, language);
      return { text, model: model ?? voice.resolved.transcribe?.id ?? "" };
    } finally {
      if (this.#recording === recording) this.#recording = null;
      this.#deps.setListening(null);
    }
  }

  /** Ends a `listen()` early, keeping what was said so far. */
  stopListening(): void {
    this.#recording?.stop();
  }

  /**
   * Speaks `text` aloud in the Workshop page, with the person's chosen model and voice unless
   * `options` names others; resolves once it has been spoken (or stopped). Speaking something
   * new stops what was being spoken.
   */
  async speak(text: string, options: SpeakOptions = {}): Promise<void> {
    const voice = this.#voice();
    if (typeof text !== "string" || !text.trim()) throw new Error("There is no text to speak.");
    if (text.length > 20 * MAX_SPEAK_CHARS) throw new Error(`At most ${20 * MAX_SPEAK_CHARS} characters are spoken at once.`);
    const model = optionalString(options?.model, "model");
    const chosen = model ? { model, voice: optionalString(options?.voice, "voice") } : { model: voice.resolved.speak?.id, voice: optionalString(options?.voice, "voice") ?? voice.resolved.voice };
    await voice.speakText(text, chosen, "gadget");
  }

  /** Stops what `speak()` is saying. */
  stopSpeaking(): void {
    this.#deps.voice()?.stopSpeaking();
  }

  /**
   * `text` (at most 2,000 characters) as audio for the gadget to play itself: a `data:` URL, which
   * is what a gadget's page may play. At most 20 a minute.
   */
  async synthesize(text: string, options: SpeakOptions = {}): Promise<{ dataUrl: string; contentType: string; model: string }> {
    const voice = this.#voice();
    if (typeof text !== "string" || !text.trim()) throw new Error("There is no text to speak.");
    const now = Date.now();
    this.#syntheses = this.#syntheses.filter((t) => now - t < 60_000);
    if (this.#syntheses.length >= SYNTHESES_PER_MINUTE) throw new Error(`At most ${SYNTHESES_PER_MINUTE} syntheses a minute.`);
    this.#syntheses.push(now);
    const model = optionalString(options?.model, "model") ?? voice.resolved.speak?.id;
    const chosenVoice = optionalString(options?.voice, "voice") ?? (model === voice.resolved.speak?.id ? voice.resolved.voice : undefined);
    const speech = await voice.synthesize(text, { model, voice: chosenVoice });
    return { dataUrl: `data:${speech.contentType};base64,${base64(speech.audio)}`, contentType: speech.contentType, model: speech.model };
  }

  /** The frame has gone (its session ended, or the page reloaded it): stop anything it started. */
  [Symbol.dispose](): void {
    this.#disposed = true;
    this.#recording?.cancel();
    this.#recording = null;
  }
}
