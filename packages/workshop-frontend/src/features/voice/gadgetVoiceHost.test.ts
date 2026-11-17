import { describe, expect, it, vi } from "vitest";
import type { VoiceModelInfo } from "@gadgets/workshop-shared/api";
import { GadgetVoiceHost } from "./gadgetVoiceHost";
import type { VoiceApi } from "./VoiceContext";

const SPEAK: VoiceModelInfo = { id: "tts", name: "TTS", kind: "speak", billing: "workers-ai", priceNote: "", isDefault: true, voices: [{ id: "luna", name: "Luna" }], defaultVoice: "luna" };

function fakeVoice(over: Partial<VoiceApi> = {}): VoiceApi {
  return {
    available: true,
    models: [SPEAK],
    settings: { readReplies: false },
    setSettings: vi.fn<VoiceApi["setSettings"]>(),
    resolved: { speak: SPEAK, voice: "luna" },
    speakingKey: null,
    speakMessage: vi.fn<VoiceApi["speakMessage"]>(async () => {}),
    speakText: vi.fn<VoiceApi["speakText"]>(async () => {}),
    stopSpeaking: vi.fn<VoiceApi["stopSpeaking"]>(),
    transcribe: vi.fn<VoiceApi["transcribe"]>(async () => "hello"),
    synthesize: vi.fn<VoiceApi["synthesize"]>(async () => ({ audio: new Uint8Array([1, 2, 3]), contentType: "audio/mpeg", model: "tts" })),
    ...over,
  };
}

function host(voice: VoiceApi | null, allow = true) {
  const askToListen = vi.fn<() => Promise<boolean>>(async () => allow);
  const setListening = vi.fn<(stop: (() => void) | null) => void>();
  return { h: new GadgetVoiceHost({ voice: () => voice, askToListen, setListening }), askToListen, setListening };
}

describe("a gadget's voice", () => {
  it("speaks with the person's model and voice unless the gadget names others", async () => {
    const voice = fakeVoice();
    const { h } = host(voice);
    await h.speak("Hello");
    expect(voice.speakText).toHaveBeenLastCalledWith("Hello", { model: "tts", voice: "luna" }, "gadget");
    await h.speak("Hi", { model: "other", voice: "nova" });
    expect(voice.speakText).toHaveBeenLastCalledWith("Hi", { model: "other", voice: "nova" }, "gadget");
  });

  it("hands back synthesized audio as a data: URL, at most 20 a minute", async () => {
    const { h } = host(fakeVoice());
    expect(await h.synthesize("Hello")).toEqual({ dataUrl: "data:audio/mpeg;base64,AQID", contentType: "audio/mpeg", model: "tts" });
    for (let i = 1; i < 20; i++) await h.synthesize("again");
    await expect(h.synthesize("one too many")).rejects.toThrow(/20 syntheses a minute/);
  });

  it("refuses what a gadget could abuse: empty or huge text, bad options, and listening without permission", async () => {
    const { h, askToListen } = host(fakeVoice(), false);
    await expect(h.speak("   ")).rejects.toThrow(/no text/);
    await expect(h.speak("a".repeat(50_000))).rejects.toThrow(/At most/);
    await expect(h.speak("Hi", { model: 42 as unknown as string })).rejects.toThrow(/model must be a string/);
    await expect(h.listen({ maxSeconds: 1000 })).rejects.toThrow(/maxSeconds/);
    await expect(h.listen()).rejects.toThrow(/did not allow/);
    // The answer holds for the rest of this page's life: the person is not asked again.
    await expect(h.listen()).rejects.toThrow(/did not allow/);
    expect(askToListen).toHaveBeenCalledTimes(1);
  });

  it("is unavailable without the page's voice, and after its frame has gone", async () => {
    expect(host(null).h.available()).toBe(false);
    await expect(host(null).h.speak("Hi")).rejects.toThrow(/not available/);
    const { h } = host(fakeVoice());
    expect(h.available()).toBe(true);
    h[Symbol.dispose]();
    expect(h.available()).toBe(false);
    await expect(h.speak("Hi")).rejects.toThrow(/not available/);
  });
});
