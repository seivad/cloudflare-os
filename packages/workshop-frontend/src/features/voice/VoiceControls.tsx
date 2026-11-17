// The chat composer's voice controls: a microphone that types what is said into the message, a
// voice menu (models, voice, reading replies aloud, starting a conversation), and the bar shown
// while a conversation runs. Each renders nothing where voice is not available.

import { useRef, useState } from "react";
import { Popover, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { CircleNotch, Headset, Microphone, SlidersHorizontal, SpeakerHigh, Stop } from "@phosphor-icons/react";
import { WorkshopIconButton } from "../../components/WorkshopControls";
import { startRecording, type Recording } from "./recorder";
import type { Conversation, ConversationState } from "./useConversation";
import { useVoice } from "./VoiceContext";

const iconButton = "!h-10 !w-10 sm:!h-8 sm:!w-8";

/** A sentence for a microphone or transcription failure. */
export function voiceErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/Permission|NotAllowed|denied/i.test(message)) return "Microphone access was refused. Allow it in the browser's site settings.";
  if (/NotFound|Requested device not found/i.test(message)) return "No microphone was found.";
  return message;
}

/** Records while held on, then types the transcript into the draft through `onTranscript`. */
export function VoiceMicButton({ onTranscript, disabled }: { onTranscript: (text: string) => void; disabled?: boolean }) {
  const voice = useVoice();
  const toasts = useKumoToastManager();
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const [level, setLevel] = useState(0);
  const recording = useRef<Recording | null>(null);
  if (!voice?.available) return null;

  const begin = async () => {
    voice.stopSpeaking();
    const rec = startRecording({ untilSilence: true, silenceMs: 2500, noSpeechMs: 15_000, maxMs: 5 * 60_000, onLevel: setLevel });
    recording.current = rec;
    setPhase("recording");
    try {
      const recorded = await rec.result;
      recording.current = null;
      if (!recorded) return;
      setPhase("transcribing");
      const text = await voice.transcribe(recorded);
      if (text) onTranscript(text);
    } catch (err) {
      toasts.add({ title: "Voice input failed", description: voiceErrorText(err), variant: "error" });
    } finally {
      recording.current = null;
      setPhase("idle");
      setLevel(0);
    }
  };

  const label = phase === "recording" ? "Stop and type what I said" : phase === "transcribing" ? "Transcribing…" : "Speak a message";
  return (
    <WorkshopIconButton
      onClick={() => (phase === "recording" ? recording.current?.stop() : phase === "idle" ? void begin() : undefined)}
      disabled={disabled || phase === "transcribing"}
      className={`${iconButton} ${phase === "recording" ? "!text-kumo-danger" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={phase === "recording"}
    >
      {phase === "transcribing" ? (
        <CircleNotch size={17} className="animate-spin" />
      ) : (
        <span className="relative inline-flex items-center justify-center">
          {phase === "recording" && (
            <span
              aria-hidden="true"
              className="absolute rounded-full bg-kumo-danger-tint transition-transform duration-75"
              style={{ width: 26, height: 26, transform: `scale(${0.7 + level * 0.8})` }}
            />
          )}
          <Microphone size={17} weight={phase === "recording" ? "fill" : "regular"} className="relative" />
        </span>
      )}
    </WorkshopIconButton>
  );
}

const selectClass = "w-full rounded-lg border border-kumo-line bg-kumo-base px-2 py-1.5 text-[12.5px] text-kumo-default outline-none focus:border-kumo-brand";

/** The voice menu: models, voice, reading replies aloud, and starting a conversation. */
export function VoiceMenu({ conversation }: { conversation?: Conversation }) {
  const voice = useVoice();
  const toasts = useKumoToastManager();
  const [open, setOpen] = useState(false);
  if (!voice?.available) return null;
  const { models, settings, setSettings, resolved } = voice;
  const transcribers = models.filter((m) => m.kind === "transcribe");
  const speakers = models.filter((m) => m.kind === "speak");

  const tryVoice = () => {
    voice.speakText("Hello! This is how I'll sound when I read replies to you.").catch((err: unknown) =>
      toasts.add({ title: "The voice could not be played", description: voiceErrorText(err), variant: "error" }));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <WorkshopIconButton className={iconButton} aria-label="Voice settings" title="Voice settings">
            <SlidersHorizontal size={16} />
          </WorkshopIconButton>
        }
      />
      <Popover.Content
        side="top"
        align="end"
        sideOffset={8}
        positionMethod="fixed"
        className="themed-floating-shadow !z-[1100] !w-[min(300px,calc(100vw-24px))] !min-w-0 rounded-xl border border-kumo-line bg-kumo-base !p-3 !outline-none [&>:first-child]:hidden"
      >
        <Popover.Title className="text-[13px] font-medium text-kumo-default">Voice</Popover.Title>
        <div className="mt-2 space-y-2.5 text-[12px] text-kumo-subtle">
          <label className="block space-y-1">
            <span>Speech to text</span>
            <select className={selectClass} value={resolved.transcribe?.id ?? ""} onChange={(e) => setSettings({ ...settings, transcribeModel: e.target.value })}>
              {transcribers.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.priceNote}</option>)}
            </select>
          </label>
          <label className="block space-y-1">
            <span>Text to speech</span>
            <select className={selectClass} value={resolved.speak?.id ?? ""} onChange={(e) => setSettings({ ...settings, speakModel: e.target.value, voice: undefined })}>
              {speakers.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.priceNote}</option>)}
            </select>
          </label>
          {resolved.speak?.voices && resolved.speak.voices.length > 1 && (
            <div className="flex items-end gap-2">
              <label className="block flex-1 space-y-1">
                <span>Voice</span>
                <select className={selectClass} value={resolved.voice ?? ""} onChange={(e) => setSettings({ ...settings, voice: e.target.value })}>
                  {resolved.speak.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </label>
              <button type="button" onClick={tryVoice} className="flex h-[30px] cursor-pointer items-center gap-1 rounded-lg border border-kumo-line px-2 text-[12px] text-kumo-default hover:bg-kumo-tint">
                <SpeakerHigh size={13} /> Try
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 pt-0.5">
            <span>Read replies aloud</span>
            <Switch aria-label="Read replies aloud" checked={settings.readReplies} onCheckedChange={(on: boolean) => setSettings({ ...settings, readReplies: on })} />
          </div>
          {conversation && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                if (conversation.state === "off") conversation.start();
                else conversation.stop();
              }}
              className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-contrast px-3 py-2 text-[12.5px] font-medium text-kumo-inverse hover:bg-kumo-strong"
            >
              <Headset size={15} />
              {conversation.state === "off" ? "Start voice conversation" : "End voice conversation"}
            </button>
          )}
          <p className="text-[11px] leading-4 text-kumo-inactive">
            Your recording is sent to the speech-to-text model; replies are spoken by the text-to-speech model. Both are paid from this deployment's AI credits.
          </p>
        </div>
      </Popover.Content>
    </Popover>
  );
}

const STATE_TEXT: Record<Exclude<ConversationState, "off">, string> = {
  listening: "Listening… speak, then pause",
  transcribing: "Got it, writing it down…",
  sending: "Sending…",
  thinking: "Thinking…",
  speaking: "Speaking… press Talk to cut in",
};

/** The bar above the composer while a voice conversation runs. */
export function ConversationBar({ conversation }: { conversation: Conversation }) {
  if (conversation.state === "off") {
    return conversation.error ? (
      <div className="mx-3 mt-2 rounded-lg bg-kumo-danger-tint px-3 py-1.5 text-[12px] text-kumo-danger" role="alert">{conversation.error}</div>
    ) : null;
  }
  const { state, level } = conversation;
  return (
    <div className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-1.5" role="status" aria-live="polite">
      <span className="relative inline-flex h-5 w-5 items-center justify-center">
        <span
          aria-hidden="true"
          className={`absolute rounded-full ${state === "listening" ? "bg-kumo-danger-tint" : "bg-kumo-tint"} transition-transform duration-75`}
          style={{ width: 20, height: 20, transform: `scale(${state === "listening" ? 0.6 + level : 1})` }}
        />
        {state === "speaking" ? <SpeakerHigh size={13} className="relative" /> : state === "listening" ? <Microphone size={13} weight="fill" className="relative text-kumo-danger" /> : <CircleNotch size={13} className="relative animate-spin" />}
      </span>
      <span className="flex-1 text-[12.5px] text-kumo-default">{STATE_TEXT[state]}</span>
      {state === "speaking" && (
        <button type="button" onClick={conversation.interrupt} className="cursor-pointer rounded-md px-2 py-1 text-[12px] font-medium text-kumo-default hover:bg-kumo-tint">Talk</button>
      )}
      <button type="button" onClick={conversation.stop} className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-kumo-danger hover:bg-kumo-danger-tint" aria-label="End voice conversation">
        <Stop size={12} weight="fill" /> End
      </button>
    </div>
  );
}

/** A reply's read-aloud button: speaks the message, or stops it while it is being spoken. */
export function ReadAloudButton({ text, messageKey, className }: { text: string; messageKey: string; className?: string }) {
  const voice = useVoice();
  const toasts = useKumoToastManager();
  if (!voice || voice.models.every((m) => m.kind !== "speak")) return null;
  const speaking = voice.speakingKey === messageKey;
  return (
    <button
      type="button"
      onClick={() => {
        if (speaking) voice.stopSpeaking();
        else voice.speakMessage(text, messageKey).catch((err: unknown) =>
          toasts.add({ title: "The reply could not be read aloud", description: voiceErrorText(err), variant: "error" }));
      }}
      className={className}
      aria-label={speaking ? "Stop reading" : "Read aloud"}
      title={speaking ? "Stop reading" : "Read aloud"}
    >
      {speaking ? <Stop size={15} weight="fill" /> : <SpeakerHigh size={15} />}
    </button>
  );
}
