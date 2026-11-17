// Conversation mode: a spoken back-and-forth with the chat's agent. It listens until the person
// pauses, transcribes what they said, sends it as their message, waits for the agent's turn to
// end, reads the reply aloud, and listens again. The microphone is closed while a reply is being
// spoken, so the agent never hears itself; pressing Talk while it speaks cuts it off.

import { useCallback, useEffect, useRef, useState } from "react";
import { startRecording, type Recording } from "./recorder";
import type { VoiceApi } from "./VoiceContext";

export type ConversationState = "off" | "listening" | "transcribing" | "sending" | "thinking" | "speaking";

/** A chat message as conversation mode reads it. */
export type SpokenMessage = { sequence: number; fromAgent: boolean; text: string };

export type Conversation = {
  state: ConversationState;
  /** The microphone's level while listening, 0 to 1. */
  level: number;
  /** The last thing that went wrong, in a sentence, until the next turn. */
  error: string | null;
  start: () => void;
  stop: () => void;
  /** Cuts off the reply being spoken and listens. */
  interrupt: () => void;
};

/** How long a turn may take before conversation mode gives up waiting for it. */
const TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * Transcripts Whisper is known to make of silence or noise; never sent as messages.
 * (Lowercased, without punctuation.)
 */
const NOISE = new Set(["", "you", "thank you", "thanks for watching", "bye", "uh", "um", "hmm"]);

export function isNoise(transcript: string): boolean {
  return NOISE.has(transcript.toLowerCase().replace(/[^a-z ]/g, "").trim());
}

/** The agent's reply to a message sent after `after`: its last message with text, once its turn has ended. */
export function replyAfter(messages: SpokenMessage[], after: number): SpokenMessage | undefined {
  let reply: SpokenMessage | undefined;
  for (const m of messages) if (m.fromAgent && m.sequence > after && m.text.trim()) reply = m;
  return reply;
}

export function useConversation({ voice, isAgentActive, messages, send }: {
  voice: VoiceApi | null;
  isAgentActive: boolean;
  messages: SpokenMessage[];
  send: (text: string) => Promise<void>;
}): Conversation {
  const [state, setState] = useState<ConversationState>("off");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const session = useRef(0);
  const recording = useRef<Recording | null>(null);
  const live = useRef({ voice, isAgentActive, messages, send });
  live.current = { voice, isAgentActive, messages, send };

  const stop = useCallback(() => {
    session.current++;
    recording.current?.cancel();
    recording.current = null;
    live.current.voice?.stopSpeaking();
    setState("off");
    setLevel(0);
  }, []);

  useEffect(() => stop, [stop]);

  const waitForReply = useCallback(async (id: number, after: number): Promise<SpokenMessage | null> => {
    const started = Date.now();
    let sawActive = false;
    for (;;) {
      if (session.current !== id) return null;
      const { isAgentActive: active, messages: list } = live.current;
      sawActive ||= active;
      // The turn starts a moment after the message is sent: wait for it, or for a reply anyway.
      const reply = replyAfter(list, after);
      if (!active && reply && (sawActive || Date.now() - started > 3000)) return reply;
      if (Date.now() - started > TURN_TIMEOUT_MS) throw new Error("The agent took too long to answer.");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, []);

  const start = useCallback(() => {
    const id = ++session.current;
    setError(null);
    void (async () => {
      while (session.current === id) {
        const v = live.current.voice;
        if (!v) break;
        try {
          setState("listening");
          const rec = startRecording({ untilSilence: true, onLevel: setLevel, maxMs: 90_000 });
          recording.current = rec;
          const recorded = await rec.result;
          recording.current = null;
          if (session.current !== id) break;
          if (!recorded) continue;
          setState("transcribing");
          const text = (await v.transcribe(recorded)).trim();
          if (session.current !== id) break;
          if (isNoise(text)) continue;
          const after = live.current.messages.reduce((max, m) => Math.max(max, m.sequence), -1);
          setState("sending");
          await live.current.send(text);
          setState("thinking");
          const reply = await waitForReply(id, after);
          if (!reply || session.current !== id) break;
          setState("speaking");
          await v.speakMessage(reply.text, `conversation:${reply.sequence}`);
        } catch (err) {
          if (session.current !== id) break;
          const message = err instanceof Error ? err.message : String(err);
          setError(/Permission|NotAllowed|denied/i.test(message) ? "Microphone access was refused. Allow it in the browser's site settings." : message);
          stop();
          break;
        }
      }
    })();
  }, [stop, waitForReply]);

  const interrupt = useCallback(() => live.current.voice?.stopSpeaking(), []);

  return { state, level, error, start, stop, interrupt };
}
