// Voice for the signed-in person's whole page: the models the deployment offers them, their
// choices (voiceSettings.ts), one player for everything spoken, and transcription. The chat
// composer, read-aloud, conversation mode and gadgets (through gadgetVoiceHost.ts) all use it.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SpeakOptions, VoiceModelInfo, VoiceSpeech } from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi } from "../../AuthContext";
import { VoicePlayer } from "./player";
import { canRecord, type Recorded } from "./recorder";
import { spokenText } from "./speechText";
import { loadVoiceSettings, resolveVoice, saveVoiceSettings, type VoiceSettings } from "./voiceSettings";

export type VoiceApi = {
  /** Whether voice can be used here: the deployment offers models and the browser can record. */
  available: boolean;
  models: VoiceModelInfo[];
  settings: VoiceSettings;
  setSettings: (next: VoiceSettings) => void;
  /** The models and voice in use: the settings' where still offered, else the defaults. */
  resolved: ReturnType<typeof resolveVoice>;
  /** The key of what is being spoken (a message's), or null when nothing is. */
  speakingKey: string | null;
  /** Reads a chat message aloud (its prose; code is skipped), stopping anything spoken before. */
  speakMessage: (markdown: string, key: string) => Promise<void>;
  /** Speaks text exactly as given, with the person's model and voice unless `options` names others. */
  speakText: (text: string, options?: SpeakOptions, key?: string) => Promise<void>;
  stopSpeaking: () => void;
  /** The text of a recording, with the person's speech-to-text model unless another is named. */
  transcribe: (recorded: Recorded, model?: string, language?: string) => Promise<string>;
  /** Text as an audio file, not played: for a gadget that plays it itself. */
  synthesize: (text: string, options: SpeakOptions) => Promise<VoiceSpeech>;
};

const VoiceContext = createContext<VoiceApi | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { authenticatedApi } = useAuthenticatedApi();
  const [models, setModels] = useState<VoiceModelInfo[]>([]);
  const [settings, setSettingsState] = useState<VoiceSettings>(() => loadVoiceSettings());
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const playerRef = useRef<VoicePlayer | null>(null);
  playerRef.current ??= new VoicePlayer((speaking) => {
    if (!speaking) {
      keyRef.current = null;
      setSpeakingKey(null);
    }
  });

  useEffect(() => {
    let cancelled = false;
    authenticatedApi.listVoiceModels().then((list) => {
      if (!cancelled) setModels(list);
    }).catch((err: unknown) => {
      // An older backend has no voice: the controls stay hidden.
      console.warn("Voice models could not be listed:", err);
    });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi]);

  useEffect(() => () => playerRef.current?.stop(), []);

  const setSettings = useCallback((next: VoiceSettings) => {
    setSettingsState(next);
    saveVoiceSettings(next);
  }, []);

  const resolved = useMemo(() => resolveVoice(settings, models), [settings, models]);

  const speaker = useCallback(
    (text: string, options: SpeakOptions): Promise<VoiceSpeech> => authenticatedApi.speak(text, options),
    [authenticatedApi],
  );

  const speakText = useCallback(async (text: string, options?: SpeakOptions, key = "text") => {
    const player = playerRef.current!;
    keyRef.current = key;
    setSpeakingKey(key);
    await player.speak(text, speaker, options ?? { model: resolved.speak?.id, voice: resolved.voice });
  }, [speaker, resolved]);

  const speakMessage = useCallback(
    (markdown: string, key: string) => speakText(spokenText(markdown), undefined, key),
    [speakText],
  );

  const stopSpeaking = useCallback(() => playerRef.current?.stop(), []);

  const transcribe = useCallback(async (recorded: Recorded, model?: string, language?: string) => {
    const result = await authenticatedApi.transcribe(recorded.audio, recorded.contentType, {
      model: model ?? resolved.transcribe?.id,
      ...(language ? { language } : {}),
    });
    return result.text;
  }, [authenticatedApi, resolved]);

  const value = useMemo<VoiceApi>(() => ({
    available: models.length > 0 && canRecord(),
    models, settings, setSettings, resolved, speakingKey, speakMessage, speakText, stopSpeaking, transcribe,
    synthesize: speaker,
  }), [models, settings, setSettings, resolved, speakingKey, speakMessage, speakText, stopSpeaking, transcribe, speaker]);

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

/** The page's voice, or null outside a signed-in page (where nothing offers it). */
export function useVoice(): VoiceApi | null {
  return useContext(VoiceContext);
}
