import Anthropic from "@anthropic-ai/sdk";
import type { StichomancyResult } from "./types";

const client = new Anthropic();

const INTERPRETATION_RULES = `
When interpreting the two passages drawn for the visitor:

1. If any recognizable biblical references appear (names like Moses, Abraham, Jerusalem, specific parables, etc.), find rough approximations that abstract them away from their source. References to God are acceptable.
2. If any recognizable references to The King in Yellow appear (Carcosa, Hastur, the Yellow Sign, Camilla, Cassilda, the Pallid Mask itself, etc.), abstract them similarly.
3. Shift all pronouns to a "you" orientation in active or future tense, depending on context.
4. If a natural seam exists to join the two passages together, do so lightly without altering the text too much. Some disjunction is acceptable — do not force coherence.

Keep your interpretation concise — a few sentences. Do not explain what you are doing. Simply present the fortune as if speaking it.
`;

export async function generateFortune(
  soulPrompt: string,
  passages: StichomancyResult,
  name: string,
  question: string
): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: soulPrompt + "\n\n" + INTERPRETATION_RULES,
    messages: [
      {
        role: "user",
        content: `The visitor's name is ${name}. They have asked: "${question}"

Two passages have been drawn by stichomancy:

From the first text:
"${passages.bibleVerse.text}"

From the second text:
"${passages.yellowPassage.text}"

Interpret these passages as a fortune for ${name}. Speak as the Pallid Mask. Address them by name.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}

export async function generateGreeting(soulPrompt: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 256,
    thinking: { type: "adaptive" },
    system: soulPrompt,
    messages: [
      {
        role: "user",
        content:
          "A visitor has just entered the room and pressed a key to begin. Greet them as the Pallid Mask. Ask for their name — nothing else. Keep it to 1-2 sentences. Do not comment on their presence or arrival — no 'you are here' or 'you have come.' Simply address them and ask the name. Speak slowly, with weight. Do not use contractions.",
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}

export async function generateAcknowledge(soulPrompt: string, name: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 512,
    thinking: { type: "adaptive" },
    system: soulPrompt,
    messages: [
      {
        role: "user",
        content:
          `The visitor has given their name: ${name}. Acknowledge them by name. Then frame the ritual — tell them they will now be asked to formulate a question. The question may concern what has been, what is, or what is yet to be. Keep it to 2-4 sentences. Speak slowly, with weight. Do not use contractions.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}
