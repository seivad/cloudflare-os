import { describe, expect, it } from "vitest";
import type { VoiceModelInfo } from "@gadgets/workshop-shared/api";
import { loadVoiceSettings, resolveVoice, saveVoiceSettings } from "./voiceSettings";

const MODELS: VoiceModelInfo[] = [
  { id: "stt-a", name: "A", kind: "transcribe", billing: "workers-ai", priceNote: "", isDefault: true },
  { id: "stt-b", name: "B", kind: "transcribe", billing: "unified", priceNote: "" },
  { id: "tts-a", name: "A", kind: "speak", billing: "workers-ai", priceNote: "", isDefault: true, voices: [{ id: "luna", name: "Luna" }, { id: "orion", name: "Orion" }], defaultVoice: "luna" },
  { id: "tts-b", name: "B", kind: "speak", billing: "unified", priceNote: "", voices: [{ id: "nova", name: "Nova" }], defaultVoice: "nova" },
];

describe("voice settings", () => {
  it("round-trip through storage, and read garbage as the defaults", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveVoiceSettings({ speakModel: "tts-b", voice: "nova", readReplies: true }, storage);
    expect(loadVoiceSettings(storage)).toEqual({ transcribeModel: undefined, speakModel: "tts-b", voice: "nova", readReplies: true });
    store.set("voiceSettings", "{not json");
    expect(loadVoiceSettings(storage)).toEqual({ readReplies: false });
  });

  it("resolve to the chosen models where offered, and to the defaults where not", () => {
    expect(resolveVoice({ speakModel: "tts-a", voice: "orion", readReplies: false }, MODELS)).toEqual({ transcribe: MODELS[0], speak: MODELS[2], voice: "orion" });
    // A voice of another model, and models no longer offered, fall back.
    expect(resolveVoice({ transcribeModel: "gone", speakModel: "tts-b", voice: "orion", readReplies: false }, MODELS)).toEqual({ transcribe: MODELS[0], speak: MODELS[3], voice: "nova" });
    expect(resolveVoice({ readReplies: false }, [])).toEqual({ transcribe: undefined, speak: undefined, voice: undefined });
  });
});
