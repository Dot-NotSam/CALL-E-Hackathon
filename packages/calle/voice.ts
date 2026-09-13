/**
 * Server-side speech synthesis with an optional ElevenLabs-first fallback.
 *
 * This produces WAV audio for a TTS-capable consumer. The installed CALL-E
 * SDK does not accept custom audio or voice settings, so this module does not
 * pretend to change the voice of a CALL-E phone call.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SpeechAudio {
  audio: Buffer;
  contentType: string;
  provider: "elevenlabs" | "kokoro";
}

export interface SpeechOptions {
  voiceId?: string;
  kokoroVoice?: string;
  modelId?: string;
  languageCode?: string;
  speed?: number;
  timeoutMs?: number;
}

const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_KOKORO_VOICE = "af_heart";
const DEFAULT_TIMEOUT_MS = 60_000;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function synthesizeWithElevenLabs(
  text: string,
  options: SpeechOptions,
): Promise<SpeechAudio> {
  const apiKey = requiredEnv("ELEVENLABS_API_KEY");
  const voiceId = options.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_ELEVENLABS_VOICE_ID;
  const modelId = options.modelId ?? process.env.ELEVENLABS_MODEL_ID ?? DEFAULT_ELEVENLABS_MODEL_ID;
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav_22050`,
    {
      method: "POST",
      headers: {
        Accept: "audio/wav",
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        ...(options.languageCode ? { language_code: options.languageCode } : {}),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs synthesis failed with HTTP ${response.status}`);
  }

  return {
    audio: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type")?.split(";", 1)[0] ?? "audio/wav",
    provider: "elevenlabs",
  };
}

async function synthesizeWithKokoro(
  text: string,
  options: SpeechOptions,
): Promise<SpeechAudio> {
  const script =
    process.env.KOKORO_SCRIPT ??
    [
      join(__dirname, "kokoro_tts.py"),
      join(process.cwd(), "packages", "calle", "kokoro_tts.py"),
    ].find((candidate) => existsSync(candidate));
  if (!script) throw new Error("kokoro_tts.py was not found");
  const output = join(process.env.TTS_OUTPUT_DIR ?? join(process.cwd(), ".tmp", "tts"), `${randomUUID()}.wav`);
  const python = process.env.KOKORO_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const voice = options.kokoroVoice ?? process.env.KOKORO_VOICE ?? DEFAULT_KOKORO_VOICE;
  const speed = String(options.speed ?? 1);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, [script, text, "--output", output, "--voice", voice, "--speed", speed], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errorText += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Kokoro synthesis timed out"));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Kokoro synthesis failed${errorText ? `: ${errorText.trim()}` : ""}`));
    });
  });

  try {
    return { audio: await readFile(output), contentType: "audio/wav", provider: "kokoro" };
  } finally {
    await import("node:fs/promises").then(({ unlink }) => unlink(output).catch(() => undefined));
  }
}

export async function synthesizeSpeech(
  text: string,
  options: SpeechOptions = {},
): Promise<SpeechAudio> {
  if (!text.trim()) throw new Error("Speech text is empty");
  try {
    return await synthesizeWithElevenLabs(text, options);
  } catch (elevenLabsError) {
    try {
      return await synthesizeWithKokoro(text, options);
    } catch (kokoroError) {
      throw new Error(
        `Speech synthesis failed: ElevenLabs unavailable (${elevenLabsError instanceof Error ? elevenLabsError.message : "unknown error"}); ` +
          `Kokoro unavailable (${kokoroError instanceof Error ? kokoroError.message : "unknown error"})`,
      );
    }
  }
}
