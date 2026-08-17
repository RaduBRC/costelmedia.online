// Standalone ElevenLabs connectivity check — isolates the API call from
// Express/auth/streaming entirely, so a failure here can only mean the
// key/voice/account itself, not anything in the app around it.
// Run: npm run test:elevenlabs
import "dotenv/config";
import { writeFile } from "node:fs/promises";

const apiKey = process.env["ELEVENLABS_API_KEY"];
const voiceId = process.env["ELEVENLABS_VOICE_ID"];

if (!apiKey || !voiceId) {
  console.error(`[test-elevenlabs] FAIL — missing env var(s): ${!apiKey ? "ELEVENLABS_API_KEY " : ""}${!voiceId ? "ELEVENLABS_VOICE_ID" : ""}`.trim());
  process.exit(1);
}

console.log(`[test-elevenlabs] Using voice ${voiceId}, key length ${apiKey.length}. Requesting synthesis...`);

const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
  method: "POST",
  headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
  body: JSON.stringify({
    text: "Test conexiune ElevenLabs",
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  }),
});

if (!response.ok) {
  console.error(`[test-elevenlabs] FAIL — HTTP ${response.status} ${response.statusText}`);
  console.error(`[test-elevenlabs] Response body: ${await response.text()}`);
  process.exit(1);
}

await writeFile("test_output.mp3", Buffer.from(await response.arrayBuffer()));
console.log("[test-elevenlabs] SUCCESS — wrote test_output.mp3");
