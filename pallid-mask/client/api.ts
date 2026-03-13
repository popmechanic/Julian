import type { GreetingResponse, FortuneResponse } from "./types";

export async function requestGreeting(): Promise<GreetingResponse> {
  const res = await fetch("/api/greeting", { method: "POST" });
  if (!res.ok) throw new Error(`Greeting failed: ${res.status}`);
  return res.json();
}

export async function requestAcknowledge(
  name: string
): Promise<GreetingResponse> {
  const res = await fetch("/api/acknowledge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Acknowledge failed: ${res.status}`);
  return res.json();
}

export async function requestFortune(
  name: string,
  question: string,
  timings: number[]
): Promise<FortuneResponse> {
  const res = await fetch("/api/fortune", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, question, timings }),
  });
  if (!res.ok) throw new Error(`Fortune failed: ${res.status}`);
  return res.json();
}

export async function requestReset(): Promise<void> {
  await fetch("/api/reset", { method: "POST" });
}
