import { spawn } from "bun";

export interface ExtractOptions {
  timeoutMs?: number;
}

/**
 * Spawn a one-shot Haiku subprocess with --json-schema to extract structured data.
 * Returns parsed JSON conforming to the provided schema.
 */
export async function extractStructured<T>(
  prompt: string,
  schema: Record<string, unknown>,
  options?: ExtractOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const schemaStr = JSON.stringify(schema);

  const proc = spawn([
    "claude",
    "--print",
    "--model", "haiku",
    "--no-session-persistence",
    "--json-schema", schemaStr,
    "--tools", "",
  ], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Write prompt to stdin and close
  proc.stdin.write(prompt);
  proc.stdin.end();

  const timer = setTimeout(() => proc.kill(), timeoutMs);

  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`extract exited ${exitCode}: ${stderr.slice(0, 200)}`);
    }
    return JSON.parse(stdout) as T;
  } finally {
    clearTimeout(timer);
  }
}
