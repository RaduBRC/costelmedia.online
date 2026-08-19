// Standalone ElevenLabs connectivity check — isolates the API call from
// Express/auth/streaming entirely, so a failure here can only mean the
// key/voice/account itself, not anything in the app around it.
// Run: npm run test:elevenlabs
//
// IMPORTANT: this only ever tests whatever ELEVENLABS_API_KEY/
// ELEVENLABS_VOICE_ID this process's *own* environment resolves to — for
// local dev, that's .env. It says nothing about what's actually deployed
// on Render, which is a separate copy of these variables set in Render's
// dashboard (see render.yaml's comment on why ELEVENLABS_* isn't tracked
// there — it's `sync: false`, set manually). A green result here plus a
// failing production /api/tts is the exact signature of those two copies
// having drifted apart — most often because the key was rotated/fixed on
// the ElevenLabs account and only the local .env got updated to match, not
// Render's. There's no way to check Render's copy from this script; the
// only way to know is comparing this result against a live production
// call (e.g. `curl -X POST https://api.costelmedia.online/api/tts ...`
// with a real session token) or checking Render's dashboard directly.
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { describeElevenLabsStatus } from "../src/telephony/elevenLabsTts.ts";

const apiKey = process.env["ELEVENLABS_API_KEY"];
const voiceId = process.env["ELEVENLABS_VOICE_ID"];

if (!apiKey || !voiceId) {
  console.error(`[test-elevenlabs] FAIL — missing env var(s): ${!apiKey ? "ELEVENLABS_API_KEY " : ""}${!voiceId ? "ELEVENLABS_VOICE_ID" : ""}`.trim());
  process.exit(1);
}

console.log(`[test-elevenlabs] Using voice ${voiceId}, key length ${apiKey.length} (${apiKey.slice(0, 6)}…). Requesting synthesis...`);

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
  console.error(`[test-elevenlabs] Diagnosis: ${describeElevenLabsStatus(response.status)}`);
  console.error(`[test-elevenlabs] Response body: ${await response.text()}`);
  process.exit(1);
}

await writeFile("test_output.mp3", Buffer.from(await response.arrayBuffer()));
console.log("[test-elevenlabs] SUCCESS — wrote test_output.mp3");
console.log(
  "[test-elevenlabs] Note: this only proves the LOCAL key/voice work. If production is still failing, Render's copy of ELEVENLABS_API_KEY has drifted from this one — see the file header comment above.",
);
