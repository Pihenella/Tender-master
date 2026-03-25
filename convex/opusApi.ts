"use node";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";

export async function callOpus(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 16384,
  maxRetries = 3
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        system: systemPrompt,
        messages: [
          { role: "user", content: userMessage },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
      }),
    });

    if (res.status === 429 || res.status === 529) {
      const waitMs = 30000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const content = data.content?.[0]?.text || "";
    if (!content) throw new Error("Empty response from Claude");
    return content;
  }
  throw new Error("Anthropic API: max retries exceeded");
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

export function extractJson(text: string): any {
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
