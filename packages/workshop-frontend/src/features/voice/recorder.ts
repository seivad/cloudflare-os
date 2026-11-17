// Recording speech from the microphone in the Workshop's own page. A gadget's frame cannot open
// the microphone (its origin is opaque), so gadgets record through this too (gadgetVoiceHost.ts).

/** A finished recording, as `AuthenticatedApi.transcribe()` takes it. */
export type Recorded = { audio: Uint8Array; contentType: string };

export type RecordOptions = {
  /** End by itself once the speaker has paused for `silenceMs` after speaking. */
  untilSilence?: boolean;
  /** The pause that ends a recording with `untilSilence`. Default 1,200 ms. */
  silenceMs?: number;
  /** With `untilSilence`, give up if nothing is said for this long. Default 10 s. */
  noSpeechMs?: number;
  /** The longest recording. Default 60 s. */
  maxMs?: number;
  /** Called about 20 times a second with the input level, 0 to 1. */
  onLevel?: (level: number) => void;
  /** Called once speech is first heard. */
  onSpeech?: () => void;
};

export type Recording = {
  /** Ends the recording and keeps what was said. */
  stop(): void;
  /** Ends the recording and throws away what was said: `result` is null. */
  cancel(): void;
  /** The recording once it ends; null when cancelled or when nothing was said. */
  result: Promise<Recorded | null>;
};

/** The recording types tried in order: Chrome and Firefox record WebM/Opus, Safari MP4/AAC. */
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

/** Whether this browser can record at all. */
export function canRecord(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

/** The level counted as speech, on the 0 to 1 scale `onLevel` reports. */
const SPEECH_LEVEL = 0.06;

/**
 * Starts recording. Throws (asynchronously, through `result`) when the microphone is refused;
 * the browser asks the person the first time.
 */
export function startRecording(options: RecordOptions = {}): Recording {
  const { untilSilence = false, silenceMs = 1200, noSpeechMs = 10_000, maxMs = 60_000, onLevel, onSpeech } = options;
  let stopRequested = false;
  let cancelled = false;
  let finish: (() => void) | undefined;
  const result = (async (): Promise<Recorded | null> => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : undefined);
    const parts: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) parts.push(event.data);
    });
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let heard = false;
    let lastLoud = Date.now();
    const started = Date.now();
    const ended = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
    const end = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
    finish = end;
    if (stopRequested || cancelled) end();
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      onLevel?.(level);
      const now = Date.now();
      if (level > SPEECH_LEVEL) {
        if (!heard) onSpeech?.();
        heard = true;
        lastLoud = now;
      }
      if (now - started > maxMs) end();
      if (untilSilence && heard && now - lastLoud > silenceMs) end();
      if (untilSilence && !heard && now - started > noSpeechMs) end();
    }, 50);
    recorder.start(250);
    try {
      await ended;
    } finally {
      clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
      void context.close();
      onLevel?.(0);
    }
    if (cancelled || (untilSilence && !heard) || parts.length === 0) return null;
    const blob = new Blob(parts, { type: recorder.mimeType || type || "audio/webm" });
    return { audio: new Uint8Array(await blob.arrayBuffer()), contentType: blob.type.split(";")[0]! };
  })();
  return {
    stop() {
      stopRequested = true;
      finish?.();
    },
    cancel() {
      cancelled = true;
      finish?.();
    },
    result,
  };
}
