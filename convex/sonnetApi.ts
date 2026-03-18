const POLZA_BASE_URL = "https://polza.ai/api/v1";
const SONNET_MODEL = "anthropic/claude-sonnet-4.6";

export async function callSonnet(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  maxRetries = 3
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 16384,
        temperature: 0.1,
      }),
    });

    if (res.status === 429) {
      const waitMs = 30000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Polza API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    if (!content) throw new Error("Empty response from Sonnet");
    return content;
  }
  throw new Error("Polza API: max retries exceeded");
}

function repairTruncatedJson(text: string): string {
  // Remove trailing incomplete value (partial string, number, etc.)
  let s = text.replace(/,\s*"[^"]*$/, "").replace(/,\s*$/, "");
  // Count unclosed brackets/braces and close them
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

/** Sanitize control characters inside JSON string literals */
function sanitizeJsonString(text: string): string {
  // Replace unescaped control chars (newlines, tabs, etc.) inside string values
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
    // Sanitize control characters inside strings
    jsonStr = sanitizeJsonString(jsonStr);
    try {
      return JSON.parse(jsonStr);
    } catch {
      return JSON.parse(repairTruncatedJson(jsonStr));
    }
  }
}
