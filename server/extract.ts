import { spawn } from "bun";

export interface ExtractOptions {
  timeoutMs?: number;
  oauthToken?: string;
}

/**
 * Unwrap CLI metadata wrapper(s) to get the actual structured output.
 * The CLI wraps results in {type:"result", subtype:"success", result:..., structured_output:...}
 * Sometimes the result field itself contains another wrapper (double-wrapped).
 */
function unwrapCliResult(obj: any): any {
  for (let depth = 0; depth < 3; depth++) {
    if (!obj || typeof obj !== 'object' || !('type' in obj)) {
      return obj;
    }

    // Prefer structured_output (used by --json-schema)
    if (obj.structured_output != null && typeof obj.structured_output === 'object') {
      return obj.structured_output;
    }

    if (obj.result !== undefined) {
      if (typeof obj.result === 'string') {
        try {
          const parsed = JSON.parse(obj.result);
          // If parsed result is another CLI wrapper, continue unwrapping
          if (parsed && typeof parsed === 'object' && 'type' in parsed && 'subtype' in parsed) {
            obj = parsed;
            continue;
          }
          return parsed;
        } catch {
          return obj.result;
        }
      }
      if (typeof obj.result === 'object' && obj.result !== null) {
        // If result is another wrapper, continue unwrapping
        if ('type' in obj.result && 'subtype' in obj.result) {
          obj = obj.result;
          continue;
        }
        return obj.result;
      }
    }

    break;
  }

  throw new Error(`Could not unwrap CLI output: keys=${Object.keys(obj).join(',')}`);
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

  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (options?.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
  }

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
    env: env as any,
  });

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
    const parsed = JSON.parse(stdout);
    return unwrapCliResult(parsed) as T;
  } finally {
    clearTimeout(timer);
  }
}
