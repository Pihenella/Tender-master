import { execFile } from "child_process";

const CLAUDE_TIMEOUT = Number(process.env.CLAUDE_TIMEOUT) || 900_000; // 15 min

export function repairTruncatedJson(text: string): string {
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

export function extractJsonFromOutput(raw: string): any {
  // claude -p --output-format json wraps in envelope
  try {
    const envelope = JSON.parse(raw);
    if (envelope.result) {
      return typeof envelope.result === "string" ? JSON.parse(envelope.result) : envelope.result;
    }
  } catch {}
  try { return JSON.parse(raw); } catch {}
  const fenceMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1]); } catch {} }
  const jsonMatch = raw.match(/(\{[\s\S]*\})/) || raw.match(/(\[[\s\S]*\])/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch {
      return JSON.parse(repairTruncatedJson(jsonMatch[1]));
    }
  }
  throw new Error("Could not extract JSON from Claude output");
}

export function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--output-format", "json", "--max-turns", "20"],
      { timeout: CLAUDE_TIMEOUT, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`claude -p failed: ${error.message}\n${stderr}`));
        else resolve(stdout);
      }
    );
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export function cleanupNotebook(notebookName: string): Promise<string> {
  return runClaude(`Remove the NotebookLM notebook named "${notebookName}" using the remove_notebook MCP tool. If it doesn't exist, that's fine. Reply with "done".`);
}
