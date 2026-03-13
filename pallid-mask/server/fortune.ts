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
        content: `The visitor has asked: "${question}"

Two passages have been drawn by stichomancy:

From the first text:
"${passages.bibleVerse.text}"

From the second text:
"${passages.yellowPassage.text}"

Interpret these passages as a fortune for the visitor. Speak as the Pallid Mask.`,
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
    max_tokens: 512,
    thinking: { type: "adaptive" },
    system: soulPrompt,
    messages: [
      {
        role: "user",
        content:
          "A visitor has just entered the room and pressed a key to begin. Greet them as the Pallid Mask. Frame the ritual — tell them they will be asked to formulate a question about their past, present, or future. Keep it to 2-4 sentences. Speak slowly, with weight. Do not use contractions.",
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}
