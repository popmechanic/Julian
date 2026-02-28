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
    "--output-format", "json",
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
    const wrapper = JSON.parse(stdout);
    // --output-format json wraps the response in CLI metadata.
    // The schema-conforming result is in structured_output or result.
    if (wrapper.structured_output && typeof wrapper.structured_output === 'object') {
      return wrapper.structured_output as T;
    }
    if (typeof wrapper.result === 'string') {
      return JSON.parse(wrapper.result) as T;
    }
    // Fallback: if it doesn't look like a wrapper, return as-is
    if (!('type' in wrapper && 'subtype' in wrapper)) {
      return wrapper as T;
    }
    throw new Error(`Unexpected CLI output shape: keys=${Object.keys(wrapper).join(',')}`);
  } finally {
    clearTimeout(timer);
  }
}
