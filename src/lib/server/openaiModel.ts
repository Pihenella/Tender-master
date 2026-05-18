import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type AiProvider = "openai-api" | "codex-cli";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const ALLOWED_REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export type OpenAIModelOptions = {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  textFormat?: Record<string, unknown>;
  provider?: AiProvider;
};

export type StructuredOutputSchema<T> = {
  name: string;
  schema: Record<string, unknown>;
  parse?: (value: unknown) => T;
};

export function getOpenAIConfig(options: OpenAIModelOptions = {}) {
  const envProvider = (process.env.AI_PROVIDER || "openai-api").toLowerCase();
  const provider: AiProvider = options.provider || (envProvider === "codex-cli" ? "codex-cli" : "openai-api");
  const envEffort = process.env.OPENAI_REASONING_EFFORT as ReasoningEffort | undefined;
  const reasoningEffort =
    options.reasoningEffort ||
    (envEffort && ALLOWED_REASONING_EFFORTS.has(envEffort) ? envEffort : DEFAULT_REASONING_EFFORT);
  const codexModel = options.model || process.env.CODEX_MODEL || process.env.OPENAI_MODEL || "";

  return {
    provider,
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: options.model || process.env.OPENAI_MODEL || (provider === "codex-cli" ? (codexModel || "codex-cli") : DEFAULT_MODEL),
    codexCommand: process.env.CODEX_COMMAND || "codex",
    codexModel,
    reasoningEffort,
    maxOutputTokens:
      options.maxOutputTokens ||
      Number(process.env.OPENAI_MAX_OUTPUT_TOKENS) ||
      DEFAULT_MAX_OUTPUT_TOKENS,
    timeoutMs:
      options.timeoutMs ||
      Number(process.env.OPENAI_TIMEOUT_MS) ||
      DEFAULT_TIMEOUT_MS,
    maxRetries:
      options.maxRetries ||
      Number(process.env.OPENAI_MAX_RETRIES) ||
      DEFAULT_MAX_RETRIES,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractOutputText(response: unknown): string {
  if (!isRecord(response)) return "";
  if (typeof response.output_text === "string") return response.output_text.trim();

  const parts: string[] = [];
  const outputs = Array.isArray(response.output) ? response.output : [];
  for (const output of outputs) {
    if (!isRecord(output)) continue;
    if (output.type === "message") {
      const contentItems = Array.isArray(output.content) ? output.content : [];
      for (const content of contentItems) {
        if (!isRecord(content)) continue;
        if (content.type === "refusal") {
          throw new Error(`OpenAI refusal: ${String(content.refusal || "request refused")}`);
        }
        if (typeof content.text === "string") parts.push(content.text);
        if (typeof content.output_text === "string") parts.push(content.output_text);
      }
    } else if (typeof output.text === "string") {
      parts.push(output.text);
    }
  }

  return parts.join("\n").trim();
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  }
  return Math.min(60000, 2000 * 2 ** attempt);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getJsonSchema(textFormat?: Record<string, unknown>) {
  if (!textFormat || textFormat.type !== "json_schema") return null;
  return isRecord(textFormat.schema) ? textFormat.schema : null;
}

function appendLimited(current: string, chunk: string, limit = 20000) {
  const combined = current + chunk;
  return combined.length > limit ? combined.slice(combined.length - limit) : combined;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match =
      text.match(/```json\s*([\s\S]*?)\s*```/) ||
      text.match(/```\s*([\s\S]*?)\s*```/) ||
      text.match(/(\{[\s\S]*\})/) ||
      text.match(/(\[[\s\S]*\])/);
    if (!match) throw new Error("No JSON object or array found");
    return JSON.parse(match[1] || match[0]);
  }
}

function buildCodexPrompt(systemPrompt: string, userMessage: string, hasSchema: boolean) {
  return `You are the local AI worker for Tender Master.

Safety and execution rules:
- Use only the content inside <system_prompt> and <user_message>.
- Do not inspect local files, run shell commands, use network access, or modify anything.
- This is a private local task for the signed-in Codex user.
- Return only the final answer${hasSchema ? " as JSON matching the provided output schema" : ""}.

<system_prompt>
${systemPrompt}
</system_prompt>

<user_message>
${userMessage}
</user_message>`;
}

async function callCodexCli(
  systemPrompt: string,
  userMessage: string,
  options: OpenAIModelOptions,
  attempt: number
): Promise<string> {
  const config = getOpenAIConfig(options);
  const dir = await mkdtemp(join(tmpdir(), "tender-codex-"));
  const outputPath = join(dir, "last-message.txt");
  const schema = getJsonSchema(options.textFormat);
  const schemaPath = join(dir, "output-schema.json");

  try {
    if (schema) {
      await writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");
    }

    const env: NodeJS.ProcessEnv = {
      HOME: process.env.HOME || "",
      PATH: process.env.PATH || "",
      TERM: process.env.TERM || "dumb",
      NODE_ENV: process.env.NODE_ENV || "development",
    };
    if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;

    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--cd",
      dir,
      "--disable",
      "shell_tool",
      "--disable",
      "web_search",
      "-c",
      "shell_environment_policy.inherit=\"none\"",
      "--output-last-message",
      outputPath,
      ...(schema ? ["--output-schema", schemaPath] : []),
      ...(config.codexModel ? ["--model", config.codexModel] : []),
      "-",
    ];

    const prompt = buildCodexPrompt(systemPrompt, userMessage, Boolean(schema));
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(config.codexCommand, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        reject(new Error(`codex exec timed out after ${config.timeoutMs / 1000}s`));
      }, config.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendLimited(stdout, chunk.toString());
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendLimited(stderr, chunk.toString());
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`codex exec exited ${code}: ${(stderr || stdout).slice(-2000)}`));
      });

      child.stdin.end(prompt);
    });

    const output = (await readFile(outputPath, "utf8").catch(() => "")).trim();
    const text = output || stdout.trim();
    if (!text) throw new Error(`Empty response from codex exec: ${stderr.slice(-2000)}`);
    return text;
  } catch (error) {
    if (attempt < (config.maxRetries || 1) - 1) {
      await wait(2000 * 2 ** attempt);
      return callCodexCli(systemPrompt, userMessage, options, attempt + 1);
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function callOpenAI(
  systemPrompt: string,
  userMessage: string,
  options: OpenAIModelOptions = {}
): Promise<string> {
  const config = getOpenAIConfig(options);
  if (config.provider === "codex-cli") {
    return callCodexCli(systemPrompt, userMessage, options, 0);
  }

  if (!config.apiKey) throw new Error("OPENAI_API_KEY is not set");

  const body = {
    model: config.model,
    reasoning: { effort: config.reasoningEffort },
    max_output_tokens: config.maxOutputTokens,
    ...(options.textFormat ? { text: { format: options.textFormat } } : {}),
    input: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userMessage,
      },
    ],
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response: Response | null = null;

    try {
      response = await fetch(`${config.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        const error = new Error(`OpenAI API ${response.status}: ${errText.slice(0, 2000)}`);
        if (RETRY_STATUSES.has(response.status) && attempt < config.maxRetries - 1) {
          lastError = error;
          await wait(retryDelayMs(response, attempt));
          continue;
        }
        throw error;
      }

      const data = await response.json();
      if (isRecord(data) && data.error) {
        throw new Error(`OpenAI API error: ${JSON.stringify(data.error)}`);
      }

      if (isRecord(data) && data.status === "incomplete") {
        const details = isRecord(data.incomplete_details) ? data.incomplete_details : {};
        throw new Error(`OpenAI response incomplete: ${String(details.reason || "unknown reason")}`);
      }

      const text = extractOutputText(data);
      if (!text) throw new Error("Empty response from OpenAI");
      return text;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isAbortError(error)) {
        lastError = new Error(`OpenAI API timed out after ${config.timeoutMs / 1000}s`);
      }
      if (attempt < config.maxRetries - 1) {
        await wait(retryDelayMs(response, attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("OpenAI API: max retries exceeded");
}

export async function callOpenAIJson<T>(
  systemPrompt: string,
  userMessage: string,
  output: StructuredOutputSchema<T>,
  options: OpenAIModelOptions = {}
): Promise<T> {
  const text = await callOpenAI(systemPrompt, userMessage, {
    ...options,
    textFormat: {
      type: "json_schema",
      name: output.name,
      strict: true,
      schema: output.schema,
    },
  });

  let parsed: unknown;
  try {
    parsed = parseJsonText(text);
  } catch (error) {
    throw new Error(`OpenAI structured output was not valid JSON: ${(error as Error).message}`);
  }

  return output.parse ? output.parse(parsed) : (parsed as T);
}
