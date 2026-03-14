import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { randomUUID } from "crypto";
import { join } from "path";

const VOICE_ID = "50I72bKDereNurpy2q0d";
const MODEL_ID = "eleven_multilingual_v2";

const client = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

const AUDIO_DIR = join(import.meta.dir, "..", "public", "audio");

function prepareForSpeech(text: string): string {
  return text
    .replace(/\n\n+/g, ' <break time="1.2s" /> ')
    .replace(/\n/g, " ");
}

export async function textToSpeech(text: string): Promise<string> {
  const audio = await client.textToSpeech.convert(VOICE_ID, {
    text: prepareForSpeech(text),
    modelId: MODEL_ID,
  });

  const id = randomUUID().slice(0, 8);
  const filename = `${id}.mp3`;
  const filepath = join(AUDIO_DIR, filename);

  // Collect stream chunks into buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of audio) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  await Bun.write(filepath, buffer);
  return `/audio/${filename}`;
}

export async function cleanupAudio(): Promise<void> {
  const { readdir, unlink } = await import("fs/promises");
  try {
    const files = await readdir(AUDIO_DIR);
    for (const file of files) {
      if (file.endsWith(".mp3")) {
        await unlink(join(AUDIO_DIR, file));
      }
    }
  } catch {
    // Directory may not exist yet — that's fine
  }
}
