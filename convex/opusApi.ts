"use node";

const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "xhigh";

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
    if (output.type !== "message") continue;
    const contentItems = Array.isArray(output.content) ? output.content : [];
    for (const content of contentItems) {
      if (!isRecord(content)) continue;
      if (content.type === "refusal") {
        throw new Error(`OpenAI refusal: ${String(content.refusal || "request refused")}`);
      }
      if (typeof content.text === "string") parts.push(content.text);
      if (typeof content.output_text === "string") parts.push(content.output_text);
    }
  }
  return parts.join("\n").trim();
}

export async function callOpenAIModel(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 16384,
  maxRetries = 3
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        reasoning: { effort: REASONING_EFFORT },
        max_output_tokens: maxTokens,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if ([408, 409, 429, 500, 502, 503, 504].includes(res.status)) {
      const waitMs = 30000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (isRecord(data) && data.status === "incomplete") {
      const details = isRecord(data.incomplete_details) ? data.incomplete_details : {};
      throw new Error(`OpenAI response incomplete: ${String(details.reason || "unknown reason")}`);
    }
    const content = extractOutputText(data);
    if (!content) throw new Error("Empty response from OpenAI");
    return content;
  }
  throw new Error("OpenAI API: max retries exceeded");
}

function repairTruncatedJson(text: string): string {
  let s = text.replace(/,\s*"[^"]*$/, "").replace(/,\s*$/, "");
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) s += '"';
  return s + stack.reverse().join("");
}

function sanitizeJsonString(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    match
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/[\x00-\x1f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
  );
}

export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch =
      text.match(/```json\s*([\s\S]*?)\s*```/) ||
      text.match(/```\s*([\s\S]*?)\s*```/) ||
      text.match(/(\[[\s\S]*\])/) ||
      text.match(/(\{[\s\S]*\})/);
    let jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;
    jsonStr = sanitizeJsonString(jsonStr);
    try {
      return JSON.parse(jsonStr);
    } catch {
      // Try to extract valid JSON by finding balanced structure
      for (const startChar of ["{", "["]) {
        const idx = jsonStr.indexOf(startChar);
        if (idx === -1) continue;
        const endChar = startChar === "{" ? "}" : "]";
        let depth = 0, inStr = false, esc = false;
        for (let i = idx; i < jsonStr.length; i++) {
          const ch = jsonStr[i];
          if (esc) { esc = false; continue; }
          if (ch === "\\") { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === startChar) depth++;
          else if (ch === endChar) {
            depth--;
            if (depth === 0) {
              try { return JSON.parse(jsonStr.substring(idx, i + 1)); } catch { break; }
            }
          }
        }
      }
      try {
        return JSON.parse(repairTruncatedJson(jsonStr));
      } catch (e) {
        throw new Error(`Failed to extract JSON from response: ${(e as Error).message}\nOriginal text (first 500 chars): ${text.substring(0, 500)}`);
      }
    }
  }
}
