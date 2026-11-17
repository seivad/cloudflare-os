// Playing spoken replies in the Workshop's page, one at a time: speaking something new stops what
// was being spoken. A long text is spoken in pieces (speechChunks), the next fetched while the
// current one plays, so the first words come quickly.

import type { SpeakOptions, VoiceSpeech } from "@gadgets/workshop-shared/api";
import { speechChunks } from "./speechText";

/** What turns a piece of text into audio: `AuthenticatedApi.speak`. */
export type Speaker = (text: string, options: SpeakOptions) => Promise<VoiceSpeech>;

export class VoicePlayer {
  #audio: HTMLAudioElement | null = null;
  #generation = 0;
  #onChange: (speaking: boolean) => void;

  constructor(onChange: (speaking: boolean) => void = () => {}) {
    this.#onChange = onChange;
  }

  /** Stops whatever is being spoken. A `speak()` in progress resolves at once. */
  stop(): void {
    this.#generation++;
    if (this.#audio) {
      this.#audio.pause();
      URL.revokeObjectURL(this.#audio.src);
      this.#audio = null;
    }
    this.#onChange(false);
  }

  /** Plays one file to its end (or until stopped), stopping anything spoken before. */
  async play(audio: Uint8Array, contentType: string): Promise<void> {
    this.stop();
    const generation = this.#generation;
    this.#onChange(true);
    try {
      await this.#playFile(audio, contentType);
    } finally {
      if (generation === this.#generation) this.#onChange(false);
    }
  }

  async #playFile(audio: Uint8Array, contentType: string): Promise<void> {
    const element = new Audio(URL.createObjectURL(new Blob([audio as BlobPart], { type: contentType })));
    this.#audio = element;
    try {
      await new Promise<void>((resolve, reject) => {
        element.addEventListener("ended", () => resolve(), { once: true });
        element.addEventListener("pause", () => resolve(), { once: true });
        element.addEventListener("error", () => reject(new Error("The audio could not be played.")), { once: true });
        element.play().catch(reject);
      });
    } finally {
      if (this.#audio === element) {
        URL.revokeObjectURL(element.src);
        this.#audio = null;
      }
    }
  }

  /**
   * Speaks `text`, stopping anything spoken before. Resolves once it has all been spoken, or once
   * something stops it.
   */
  async speak(text: string, speaker: Speaker, options: SpeakOptions): Promise<void> {
    this.stop();
    const generation = this.#generation;
    const chunks = speechChunks(text);
    if (chunks.length === 0) return;
    this.#onChange(true);
    try {
      let next = speaker(chunks[0]!, options);
      for (let i = 0; i < chunks.length; i++) {
        const speech = await next;
        if (generation !== this.#generation) return;
        if (i + 1 < chunks.length) next = speaker(chunks[i + 1]!, options);
        await this.#playFile(speech.audio, speech.contentType);
        if (generation !== this.#generation) return;
      }
    } finally {
      if (generation === this.#generation) this.#onChange(false);
    }
  }
}
