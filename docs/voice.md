# Voice

Speech to text and text to speech in the Workshop: in the chat, and in gadgets.

## In the chat

The composer has two voice controls beside the model picker:

- **Microphone.** Press it and speak; it stops by itself after a pause of about two and a half seconds (or press it again), and what was said is typed into the message to edit and send.
- **Voice settings.** The speech-to-text model, the text-to-speech model and its voice (with **Try**), **Read replies aloud**, and **Start voice conversation**.

In a conversation the Workshop listens until the person pauses, sends what they said as their message, waits for the agent's turn to end, reads the reply aloud, and listens again. The microphone is closed while a reply is spoken, so the agent never hears itself; **Talk** cuts the reply off, and **End** stops. Only the agent's last message of the turn is read, its prose only: code blocks are announced rather than read, and links are read by their text. A conversation needs a chat to talk in, so it is offered in a chat, not on the new-chat page.

Each agent reply also has a read-aloud button beside **Copy**. **Read replies aloud** reads each reply as its turn ends, from the moment the chat is opened.

The choices are kept in the browser (`localStorage` key `voiceSettings`), like the composer's model choice.

## In gadgets

A gadget's frame has an opaque origin, so it cannot open the microphone, and its content security policy lets it play only `data:` URLs. The Workshop page therefore records and speaks for it: `client.js` gets a `voice` global, an RPC stub to `GadgetVoiceHost` (`packages/workshop-frontend/src/features/voice/gadgetVoiceHost.ts`) over a MessagePort of its own, set up by the code `GadgetUI.tsx` injects before the gadget's.

| Call | What it does |
| --- | --- |
| `voice.available()` | Whether voice can be used on this page. |
| `voice.listen({ untilSilence, maxSeconds, model, language, onLevel })` | Records until the person pauses (or for at most `maxSeconds`, 1 to 300, default 60) and answers `{ text, model }`, or null if nothing was said. |
| `voice.stopListening()` | Ends a `listen()` early, keeping what was said. |
| `voice.speak(text, { model, voice })` | Speaks through the Workshop page; resolves once it has been spoken. |
| `voice.stopSpeaking()` | Cuts it off. |
| `voice.synthesize(text, { model, voice })` | Answers `{ dataUrl, contentType, model }` for the gadget to play itself; at most 20 a minute. |
| `voice.models()` | The models offered. |

The first `listen()` each time the gadget's page is opened asks the person, in the Workshop's own UI above the frame, whether the gadget may use the microphone; a refusal holds until the page is opened again. While it listens, the Workshop shows **Gadget is listening** with **Stop**. Every argument the frame passes is checked, since the frame runs agent-written code that may come from someone else's blueprint. The agent's instructions for writing gadgets describe the global (`agent.ts`, "Voice in a Gadget").

## Models

`AuthenticatedApi.listVoiceModels()`, `transcribe()` and `speak()` (`packages/workshop-backend/src/voice.ts`) run each model over the `WORKERS_AI` binding on the deployment's AI Gateway, with the user and `source: "voice"` in the gateway metadata. Without a gateway reachable over the binding, no models are listed and the controls are hidden.

| Model | Kind | Billing |
| --- | --- | --- |
| `@cf/openai/whisper-large-v3-turbo` (default) | Speech to text | Workers AI |
| `openai/gpt-4o-transcribe` | Speech to text | AI Gateway catalog |
| `@cf/deepgram/aura-2-en` (default) | Text to speech, 40 voices | Workers AI |
| `@cf/deepgram/aura-1` | Text to speech, 12 voices, fastest | Workers AI |
| `@cf/myshell-ai/melotts` | Text to speech, six languages | Workers AI |
| `openai/tts-1`, `xai/grok-tts`, `elevenlabs/eleven-v3` | Text to speech | AI Gateway catalog |

A recording is at most 10 MB, and one `speak()` at most 2,000 characters (the page speaks a long reply in pieces, the first short so speech starts soon). GPT-4o Transcribe refused Safari's MP4 recordings, so an MP4 recording sent to it is transcribed by Whisper instead, and the answer names the model that heard it. Deepgram Nova 3 is not offered: it takes its recording as a stream, which AI Gateway refuses.

A user whose requests go through the deployment's dynamic route (`CF_AI_GATEWAY_ROUTE`, see [public-server.md](public-server.md)) is offered the Workers AI models only: a route takes chat requests alone, so it cannot count what a catalog voice model costs against their budget.
