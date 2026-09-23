import type { Speaker } from "../types";

export function isTechnicalSpeakerName(name: string) {
  return /^(?:(?:спикер|голос)\s*(?:№\s*)?\d+|speaker[\s_-]*\d+)$/iu.test(
    name.trim(),
  );
}

export function speakerIdentification(speaker: Speaker): Speaker["identification"] {
  return isTechnicalSpeakerName(speaker.display_name)
    ? "unknown"
    : speaker.identification;
}
