import { describe, expect, it, vi } from "vitest";
import { MAX_SPEAK_CHARS, MAX_VOICE_AUDIO_BYTES } from "@gadgets/workshop-shared/api";
import { AiGatewayLogRetryableError } from "../src/ai-gateway.js";
import { listVoiceModels, speak, transcribe, voiceCostEntry, type VoiceCost } from "../src/voice.js";

const USER = "ada@example.com";

/** An environment whose gateway rides a stand-in Workers AI binding answering with `respond`. */
function voiceEnv(respond: (model: string, input: Record<string, unknown>) => unknown, overrides: Partial<Cloudflare.Env> = {}, logId?: string) {
  const ai = { fetch: vi.fn(), aiGatewayLogId: undefined as string | undefined };
  const run = vi.fn(async (model: string, input: Record<string, unknown>, _options: unknown) => {
    ai.aiGatewayLogId = logId;
    return respond(model, input);
  });
  const bound = {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
    CF_AI_GATEWAY_PROVIDERS: "cloudflare",
    WORKERS_AI: Object.assign(ai, { run }) as unknown as Ai,
    ...overrides,
  } as Cloudflare.Env;
  return { bound, run };
}

const recording = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);

describe("voice models", () => {
  it("offers speech-to-text and text-to-speech models, one default of each", () => {
    const models = listVoiceModels(voiceEnv(() => null).bound, USER);
    expect(models.filter((m) => m.isDefault).map((m) => [m.kind, m.id])).toEqual([
      ["transcribe", "@cf/openai/whisper-large-v3-turbo"],
      ["speak", "@cf/deepgram/aura-2-en"],
    ]);
    expect(models.some((m) => m.billing === "unified")).toBe(true);
    for (const model of models.filter((m) => m.kind === "speak")) {
      expect(model.voices!.map((v) => v.id)).toContain(model.defaultVoice);
    }
  });

  it("offers a user the route budgets the Workers AI models only", () => {
    const { bound } = voiceEnv(() => null, { CF_AI_GATEWAY_ROUTE: "workshop", CF_AI_GATEWAY_ROUTE_DOMAINS: "example.gov.au" });
    const budgeted = listVoiceModels(bound, "jo@example.gov.au");
    expect(budgeted.length).toBeGreaterThan(0);
    expect(budgeted.every((m) => m.billing === "workers-ai")).toBe(true);
    expect(listVoiceModels(bound, USER).some((m) => m.billing === "unified")).toBe(true);
  });

  it("offers nothing without a gateway reachable over the binding", () => {
    expect(listVoiceModels({ CF_AI_GATEWAY: undefined } as unknown as Cloudflare.Env, USER)).toEqual([]);
  });
});

describe("transcribe", () => {
  it("sends the recording to the default model through the gateway, with the user in the metadata", async () => {
    const { bound, run } = voiceEnv(() => ({ text: "  Book a meeting for Thursday.  " }));
    expect(await transcribe(bound, USER, recording, "audio/webm;codecs=opus", { language: "en" }))
        .toMatchObject({ text: "Book a meeting for Thursday.", model: "@cf/openai/whisper-large-v3-turbo" });
    const [model, input, options] = run.mock.calls[0]!;
    expect(model).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(input).toEqual({ audio: btoa(String.fromCharCode(...recording)), language: "en", vad_filter: true });
    expect(options).toEqual({ gateway: { id: "platform-gateway", metadata: { user: USER, source: "voice" } } });
  });

  it("sends a catalog model a data: URL, and gives way to the default for a recording type it refuses", async () => {
    const { bound, run } = voiceEnv((model) => model === "openai/gpt-4o-transcribe" ? { state: "Completed", result: { text: "hello" } } : { text: "hello there" });
    expect(await transcribe(bound, USER, recording, "audio/webm", { model: "openai/gpt-4o-transcribe" })).toMatchObject({ text: "hello", model: "openai/gpt-4o-transcribe" });
    expect(run.mock.calls[0]![1]).toEqual({ file: `data:audio/webm;base64,${btoa(String.fromCharCode(...recording))}` });
    // Safari records MP4, which that model refused.
    expect(await transcribe(bound, USER, recording, "audio/mp4", { model: "openai/gpt-4o-transcribe" })).toMatchObject({ text: "hello there", model: "@cf/openai/whisper-large-v3-turbo" });
  });

  it("refuses an empty, oversized or non-audio recording, an unknown model, and a catalog model for a budgeted user", async () => {
    const { bound, run } = voiceEnv(() => ({ text: "x" }), { CF_AI_GATEWAY_ROUTE: "workshop", CF_AI_GATEWAY_ROUTE_DOMAINS: "example.gov.au" });
    await expect(transcribe(bound, USER, new Uint8Array(0), "audio/webm")).rejects.toThrow(/empty/);
    await expect(transcribe(bound, USER, new Uint8Array(MAX_VOICE_AUDIO_BYTES + 1), "audio/webm")).rejects.toThrow(/larger than 10 MB/);
    await expect(transcribe(bound, USER, recording, "text/html")).rejects.toThrow(/must be audio/);
    await expect(transcribe(bound, USER, recording, "audio/webm", { model: "@cf/nope" })).rejects.toThrow(/No speech-to-text model/);
    await expect(transcribe(bound, "jo@example.gov.au", recording, "audio/webm", { model: "openai/gpt-4o-transcribe" })).rejects.toThrow(/No speech-to-text model/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("transcribe cost", () => {
  it("returns the gateway log id it ran under", async () => {
    const { bound } = voiceEnv(() => ({ text: "hi" }), {}, "v-1");
    expect((await transcribe(bound, USER, recording, "audio/webm")).cost)
        .toEqual({ kind: "transcription", model: "@cf/openai/whisper-large-v3-turbo", gatewayLogId: "v-1" });
  });

  it("returns no log id when the binding reported none", async () => {
    const { bound } = voiceEnv(() => ({ text: "hi" }));
    expect((await transcribe(bound, USER, recording, "audio/webm")).cost.gatewayLogId).toBeUndefined();
  });
});

describe("speak", () => {
  it("returns kind speech and its model", async () => {
    const { bound } = voiceEnv(() => new Response(new Uint8Array([1])).body, {}, "s-1");
    expect((await speak(bound, USER, "Hi")).cost).toEqual({ kind: "speech", model: "@cf/deepgram/aura-2-en", gatewayLogId: "s-1" });
  });

  it("reads a Workers AI model's MP3 stream, in the voice asked for", async () => {
    const mp3 = new Uint8Array([0xff, 0xf3, 1, 2]);
    const { bound, run } = voiceEnv(() => new Response(mp3).body);
    const speech = await speak(bound, USER, " Hello there. ", { voice: "orion" });
    expect(speech).toMatchObject({ audio: mp3, contentType: "audio/mpeg", model: "@cf/deepgram/aura-2-en" });
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual(["@cf/deepgram/aura-2-en", { text: "Hello there.", speaker: "orion", encoding: "mp3" }]);
  });

  it("uses the model's own voice for one it doesn't have, and decodes base64 WAV", async () => {
    const { bound, run } = voiceEnv(() => ({ audio: btoa("RIFF0000") }));
    const speech = await speak(bound, USER, "Bonjour", { model: "@cf/myshell-ai/melotts", voice: "klingon" });
    expect(speech.contentType).toBe("audio/wav");
    expect(new TextDecoder().decode(speech.audio)).toBe("RIFF0000");
    expect(run.mock.calls[0]![1]).toEqual({ prompt: "Bonjour", lang: "en" });
  });

  it("fetches a catalog model's file from the link it answers with", async () => {
    const { bound } = voiceEnv(() => ({ state: "Completed", result: { audio: "https://files.example.test/out.mp3" } }));
    const fetcher = vi.fn(async () => new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/mpeg" } }));
    const speech = await speak(bound, USER, "Hi", { model: "openai/tts-1" }, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith("https://files.example.test/out.mp3");
    expect(speech).toMatchObject({ audio: new Uint8Array([9, 9]), contentType: "audio/mpeg", model: "openai/tts-1" });
  });

  it("refuses empty or overlong text, and a model of the other kind", async () => {
    const { bound, run } = voiceEnv(() => null);
    await expect(speak(bound, USER, "   ")).rejects.toThrow(/no text/);
    await expect(speak(bound, USER, "a".repeat(MAX_SPEAK_CHARS + 1))).rejects.toThrow(/in parts/);
    await expect(speak(bound, USER, "Hi", { model: "@cf/openai/whisper-large-v3-turbo" })).rejects.toThrow(/No text-to-speech model/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("voiceCostEntry", () => {
  const cost: VoiceCost = { kind: "transcription", model: "@cf/openai/whisper-large-v3-turbo", gatewayLogId: "v-1" };
  const { bound } = voiceEnv(() => null);

  it("counts the log's cost as logged, not estimated", async () => {
    const readLog = vi.fn(async () => ({ cost: 0.002 }));
    expect(await voiceCostEntry(bound, cost, readLog, async () => {}))
        .toEqual({ kind: "transcription", model: cost.model, estimated: false, usd: 0.002, source: "voice" });
    expect(readLog).toHaveBeenCalledWith(bound, { gateway: "platform-gateway" }, "v-1");
  });

  it("waits 1, 2 and 4 seconds while the log is not ready, and gives up after four reads", async () => {
    const waits: number[] = [];
    const readLog = vi.fn(async () => { throw new AiGatewayLogRetryableError("not yet"); });
    await expect(voiceCostEntry(bound, cost, readLog, async (ms) => { waits.push(ms); })).rejects.toThrow("not yet");
    expect(readLog).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("counts a log that becomes ready on a later read", async () => {
    let reads = 0;
    const readLog = vi.fn(async () => { if (++reads < 3) throw new AiGatewayLogRetryableError("not yet"); return { cost: 0.5 }; });
    expect((await voiceCostEntry(bound, cost, readLog, async () => {}))?.usd).toBe(0.5);
  });

  it("does not retry a refusal", async () => {
    const readLog = vi.fn(async () => { throw new Error("invalid cost"); });
    await expect(voiceCostEntry(bound, cost, readLog, async () => {})).rejects.toThrow("invalid cost");
    expect(readLog).toHaveBeenCalledTimes(1);
  });

  it("counts nothing for a call with no log id", async () => {
    const readLog = vi.fn();
    expect(await voiceCostEntry(bound, { ...cost, gatewayLogId: undefined }, readLog, async () => {})).toBeUndefined();
    expect(readLog).not.toHaveBeenCalled();
  });
});
