// A person's voice choices, kept in this browser like the composer's model choice
// (modelSelection.ts): the models and voice used, and whether replies are read aloud.

import type { VoiceModelInfo } from "@gadgets/workshop-shared/api";

export type VoiceSettings = {
  /** Speech-to-text model id; absent for the deployment's default. */
  transcribeModel?: string;
  /** Text-to-speech model id; absent for the deployment's default. */
  speakModel?: string;
  /** One of the speak model's voices; absent for its default. */
  voice?: string;
  /** Read each finished reply aloud. */
  readReplies: boolean;
};

const KEY = "voiceSettings";

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { readReplies: false };

export function loadVoiceSettings(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): VoiceSettings {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return DEFAULT_VOICE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return {
      transcribeModel: text(parsed.transcribeModel),
      speakModel: text(parsed.speakModel),
      voice: text(parsed.voice),
      readReplies: parsed.readReplies === true,
    };
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

export function saveVoiceSettings(settings: VoiceSettings, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private windows and full storage keep the choice for this page only.
  }
}

/**
 * The models and voice the settings name, where still offered; otherwise the defaults. A model
 * taken away (a budgeted person loses the Unified ones) falls back without a word.
 */
export function resolveVoice(settings: VoiceSettings, models: VoiceModelInfo[]): { transcribe?: VoiceModelInfo; speak?: VoiceModelInfo; voice?: string } {
  const of = (kind: VoiceModelInfo["kind"], id: string | undefined) =>
    models.find((m) => m.kind === kind && m.id === id) ?? models.find((m) => m.kind === kind && m.isDefault) ?? models.find((m) => m.kind === kind);
  const speak = of("speak", settings.speakModel);
  const voice = speak?.voices?.some((v) => v.id === settings.voice) ? settings.voice : speak?.defaultVoice;
  return { transcribe: of("transcribe", settings.transcribeModel), speak, voice };
}
