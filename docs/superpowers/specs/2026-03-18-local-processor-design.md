# Local Processor: Claude Code + NotebookLM RAG

## Summary

Replace cloud-based AI processing (Gemini Flash API + Sonnet/Polza API) with a local pipeline using Claude Code (Opus 4.6 on Max subscription) and NotebookLM (via MCP) for RAG. The new pipeline runs as a systemd daemon on the user's machine, polling Convex for tasks. The existing cloud pipeline remains intact and is selectable via a `processingMode` toggle.

## Motivation

- **Cost**: Eliminate per-call API costs (Gemini, Polza/Sonnet) — processing covered by existing subscriptions (Claude Max + Google AI Pro)
- **Quality**: Opus 4.6 > Sonnet 4.6 > Flash 2.5 for structured extraction from Russian procurement documents
- **Accuracy**: NotebookLM RAG provides source-grounded answers with citations, reducing hallucination risk for item specs, form coordinates, and pricing data
- **Safety**: Old pipeline untouched — `processingMode: "cloud"` works exactly as before

## Architecture

```
┌─────────────────────────────────────┐
│  Web UI (Next.js)                   │
│  processingMode toggle: cloud/local │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│  Convex Backend                     │
│  - procurements.processingMode      │
│  - New statuses:                    │
│    pending_local_analysis           │
│    pending_local_fill               │
│  - HTTP router (http.ts)            │
│  - Extracted actions for slicing    │
│    and Excel generation             │
└──────────────┬──────────────────────┘
               │ polling every 30s
┌──────────────▼──────────────────────┐
│  Local Daemon (Node.js + systemd)   │
│  daemon.ts → loop:                  │
│    1. Query Convex HTTP API         │
│    2. Download files from storage   │
│    3. Upload to NotebookLM (MCP)    │
│    4. Run claude -p with prompts    │
│    5. Push results back to Convex   │
└─────────────────────────────────────┘
```

## Processing Modes

### Cloud mode (existing, unchanged)

```
Upload → Gemini Flash (Stage 1) → docxSlicer (Stage 2) → Sonnet calc (Stage 3)
→ User fills calc → Sonnet form fill (Stage 4) → Sonnet verify (Stage 5)
```

### Local mode (new)

```
Upload → pending_local_analysis → daemon picks up →
  Claude Code + NotebookLM RAG (extraction + calc data) →
  Convex action: sliceForms + generateCalcExcel (pure code) →
  User fills calc → uploads → pending_local_fill → daemon picks up →
  Claude Code + NotebookLM RAG (fill instructions + self-verify) →
  Convex action: applyFillInstructions (pure code)
```

## Components

### 1. Convex Schema Changes

Add to `procurements` table:
- `processingMode`: `v.optional(v.union(v.literal("cloud"), v.literal("local")))` — defaults to `"cloud"`
- `localRetryCount`: `v.optional(v.number())` — counter for stale task recovery (max 3 retries)

Extend `status` union with new literals:
- `pending_local_analysis` — waiting for local daemon to pick up analysis
- `pending_local_fill` — waiting for local daemon to pick up form filling

**Note**: This modifies the `v.union()` in schema.ts. Existing procurements without `processingMode` default to cloud behavior. All UI status switches must handle the new values (display "Ожидание локальной обработки..." badge).

### 2. Convex HTTP Router (http.ts) — NEW

Required because Convex does not expose queries/mutations over HTTP by default. Create `convex/http.ts` with endpoints:

```
POST /api/local/pending-tasks     → calls getPendingLocalTasks query
POST /api/local/update-status     → calls updateStatus mutation
POST /api/local/save-analysis     → calls saveLocalAnalysisResult mutation
POST /api/local/save-fill         → calls saveLocalFillResult mutation
POST /api/local/trigger-slice     → calls sliceFormsAction (new internal action)
POST /api/local/trigger-calc      → calls generateCalcAction (new internal action)
POST /api/local/trigger-apply     → calls applyFillAction (new internal action)
GET  /api/local/download/:id      → proxies Convex storage download
POST /api/local/upload            → proxies Convex storage upload
```

Auth: `CONVEX_LOCAL_PROCESSOR_SECRET` env var, sent as `Authorization: Bearer <secret>` header, checked on every request (including GET download endpoint). Set on both Convex deployment and local daemon. HTTPS enforced by default (Convex cloud URLs are always HTTPS).

### 3. Extracted Convex Actions — NEW

Currently, form slicing (analysis.ts:355-445) and Excel generation (analysis.ts:475-601) are embedded in `analyzeDocuments`. Extract into separate internal actions that both pipelines use:

- `internal.analysisActions.sliceForms(procurementId)` — reads extractedData.forms, runs docxSlicer, saves to extractedForms table
- `internal.analysisActions.generateCalcExcel(procurementId)` — reads calculationData, builds Excel with ExcelJS, saves to generatedFiles
- `internal.analysisActions.applyFillInstructions(procurementId)` — reads fill instructions from DB, applies to form files (extracted from formFilling.ts)

The existing `analyzeDocuments` action calls these internally. The local pipeline triggers them via HTTP router after pushing AI results.

### 4. File Structure

```
scripts/local-processor/
├── daemon.ts                 # Main polling loop (Node.js)
├── process-analysis.ts       # Stage 1+3: extraction + calculation data
├── process-fill.ts           # Stage 4+5: form filling instructions
├── convex-client.ts          # Convex HTTP API wrapper
├── prompts/
│   ├── extraction.md         # RAG extraction prompt
│   └── form-filling.md       # RAG form filling prompt
├── export-profiles.ts        # Script: imports profiles.ts, writes profiles.json
├── profiles.json             # Auto-generated by export-profiles.ts (git-ignored)
├── tsconfig.json             # TypeScript config for scripts
├── package.json              # Dependencies: node-fetch, etc.
├── install-service.sh        # Install systemd user service
└── uninstall-service.sh      # Remove systemd user service
```

### 5. Daemon (daemon.ts) — Node.js

```typescript
import { ConvexClient } from "./convex-client";
import { processAnalysis } from "./process-analysis";
import { processFill } from "./process-fill";

const POLL_INTERVAL = 30_000;
const client = new ConvexClient(process.env.CONVEX_URL!, process.env.CONVEX_SECRET!);

async function loop() {
  while (true) {
    try {
      const tasks = await client.getPendingTasks();
      for (const task of tasks) {
        try {
          if (task.status === "pending_local_analysis") {
            await processAnalysis(client, task);
          } else if (task.status === "pending_local_fill") {
            await processFill(client, task);
          }
        } catch (err) {
          console.error(`Task ${task._id} failed:`, err);
          const rollbackStatus = task.status === "pending_local_analysis"
            ? "uploaded"
            : "calculation_uploaded";
          await client.updateStatus(task._id, rollbackStatus, `Ошибка: ${err.message}`);
        }
      }
    } catch (err) {
      console.error("Polling error:", err);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

loop();
```

Key design decisions:
- **Node.js, not bash**: Direct access to JSON, TypeScript types, profiles.ts, and robust error handling
- **Sequential processing**: One task at a time to avoid Claude Code rate limits on Max subscription
- **Error rollback**: Analysis errors → `uploaded`, fill errors → `calculation_uploaded` (matches cloud pipeline convention)

### 6. Analysis Pipeline (process-analysis.ts)

Steps:
1. Update status to `analyzing` via HTTP API
2. Download all procurement files from Convex Storage to temp dir
3. Create NotebookLM notebook named `"Закупка_{number}"` via MCP
4. Upload document files to the notebook
5. Run `claude -p --output-format json` with extraction prompt via `child_process.execFile`:
   - Prompt instructs Claude to make RAG queries via NotebookLM MCP (`ask_question`)
   - Extract: procurementNumber, procurementName, nmck, deliveryDeadline, deliveryAddresses
   - Extract: items[] with full details (name, quantity, unit, nmckPrice, tzSpecs, pp1875, quarter, weights, dimensions, allocations)
   - Extract: forms[] with coordinates (name, sourceFile, locationType, startBlock, endBlock, sheetName)
   - Generate: calcRows[] (itemName, pp1875, quantity, nmckPrice, tzSpecs) — replaces Stage 3 Sonnet call
6. Validate and repair JSON output (reuse `repairTruncatedJson` / `extractJson` logic from `analysis.ts`). Note: `claude -p --output-format json` wraps output in a metadata envelope — extract `.result` field before parsing the extraction JSON.
7. **Cancellation check**: query current procurement status from Convex. If status is no longer `analyzing` (user cancelled), abort without pushing results.
8. Push structured data to Convex via `saveLocalAnalysisResult` HTTP endpoint
9. Trigger `sliceForms` action via HTTP (Convex runs docxSlicer server-side)
10. Trigger `generateCalcExcel` action via HTTP (Convex runs ExcelJS server-side)
11. Update status to `analyzed`

Timeout: 15 minutes for `claude -p` (configurable via env var).

### 7. Form Filling Pipeline (process-fill.ts)

Steps:
1. Update status to `filling_forms`
2. Download: filled calculation XLSX + extracted form files from Convex
3. Load profile data from `profiles.json`
4. Upload forms to NotebookLM notebook (reuse or create)
5. Run `claude -p --output-format json` with form-filling prompt:
   - Prompt includes: company profile, pricing from calc, item details
   - For each form, generate fill instructions:
     - DOCX: `{type: "replace", search, value}` or `{type: "fillTable", markerText, columns, rows}`
     - XLSX: `{type: "cell", row, col, value}` or `{type: "fillRows", startRow, rows}`
   - Self-verification built into prompt: Claude re-reads instructions and checks for errors
6. Validate JSON output
7. **Cancellation check**: query current procurement status. If no longer `filling_forms`, abort.
8. Push fill instructions to Convex via `saveLocalFillResult` HTTP endpoint
9. Trigger `applyFillInstructions` action via HTTP (Convex applies to files server-side)
10. Update status to `completed`

### 8. Convex Client (convex-client.ts)

```typescript
export class ConvexClient {
  constructor(private baseUrl: string, private secret: string) {}

  async getPendingTasks(): Promise<Task[]> { /* POST /api/local/pending-tasks */ }
  async updateStatus(id: string, status: string, message?: string) { /* POST /api/local/update-status */ }
  async saveAnalysisResult(id: string, data: AnalysisResult) { /* POST /api/local/save-analysis */ }
  async saveFillResult(id: string, formId: string, instructions: any[]) { /* POST /api/local/save-fill */ }
  async triggerSlice(id: string) { /* POST /api/local/trigger-slice */ }
  async triggerCalc(id: string) { /* POST /api/local/trigger-calc */ }
  async triggerApply(id: string) { /* POST /api/local/trigger-apply */ }
  async downloadFile(storageId: string, outputPath: string) { /* GET /api/local/download/:id */ }
  async uploadFile(filePath: string): Promise<string> { /* POST /api/local/upload */ }
}
```

### 9. NotebookLM MCP Setup

Prerequisites:
- `claude mcp add notebooklm npx notebooklm-mcp@latest`
- One-time browser auth: "Log me in to NotebookLM"
- Google AI Pro subscription ($19.99/month) for extended limits

The MCP server runs automatically when Claude Code starts. `claude -p` inherits MCP config from `~/.claude/mcp.json`.

**Important**: Before deploying as systemd service, verify that `claude -p` with MCP works without TTY:
```bash
systemd-run --user --pty claude -p "test notebooklm connection"
```
If MCP requires TTY for auth renewal, the daemon must detect auth failures and alert the user (e.g., write to a status file or send a desktop notification).

### 10. UI Changes

In procurement detail page:
- Add toggle: "Обработка: Облако / Локально"
- Saved as `processingMode` on the procurement record
- When `local`: "Анализировать" button sets status to `pending_local_analysis`
- When `local`: "Заполнить формы" button sets status to `pending_local_fill`
- When `cloud`: buttons work as before (trigger Convex actions directly)
- Status badges show `pending_local_*` states with "Ожидание локальной обработки..." message
- **Toggle disabled** while procurement is in any active processing state (prevents race conditions)
- Calculation upload flow (`calculation_uploaded` status) works identically in both modes

### 11. Systemd User Service

```ini
[Unit]
Description=Tender Master Local Processor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /home/Iurii/Projects/tender-master/scripts/local-processor/daemon.ts
Restart=always
RestartSec=10
WorkingDirectory=/home/Iurii/Projects/tender-master/scripts/local-processor
Environment=CONVEX_URL=https://industrious-salmon-568.convex.cloud
Environment=CONVEX_SECRET=<set-during-install>
Environment=CLAUDE_TIMEOUT=900000
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Install as user service: `systemctl --user enable --now tender-master-processor`
View logs: `journalctl --user -u tender-master-processor -f`

### 12. Stale Task Recovery

Convex cron job (every 5 minutes):
- Query filter: `processingMode === "local"` AND (`status === "analyzing"` OR `status === "filling_forms"`) AND `_creationTime` of status change > 15 min ago
- **Critical**: The cron MUST check `processingMode === "local"` to avoid resetting cloud pipeline tasks that legitimately take longer than 15 minutes
- Reset `analyzing` → `pending_local_analysis`, `filling_forms` → `pending_local_fill`
- Counter field `localRetryCount` prevents infinite retries (max 3, then status → `error`)

```typescript
// Cron pseudocode
const staleTasks = await ctx.db.query("procurements")
  .filter(q => q.and(
    q.eq(q.field("processingMode"), "local"),
    q.or(
      q.eq(q.field("status"), "analyzing"),
      q.eq(q.field("status"), "filling_forms")
    )
  )).collect();
// Check timestamp and retryCount before resetting
```

### 13. NotebookLM Notebook Cleanup

After processing completes (status → `analyzed` or `completed`):
- Daemon deletes the NotebookLM notebook via MCP `remove_notebook`
- Prevents accumulation of stale notebooks in the Google account

## What Does NOT Change

- `convex/analysis.ts` — cloud pipeline logic unchanged (internal calls refactored to use extracted actions, but behavior identical)
- `convex/formFilling.ts` — cloud pipeline, untouched
- `convex/sonnetApi.ts` — cloud pipeline, untouched
- `convex/docxSlicer.ts` — reused by extracted actions, code unchanged
- `convex/calculationUpload.ts` — shared, unchanged
- `src/lib/parsers.ts` — shared, unchanged
- `src/lib/profiles.ts` — shared; also exported to `profiles.json` for local daemon

## Error Handling

- If daemon crashes: systemd restarts in 10s
- If `claude -p` fails: rollback to `uploaded` (analysis) or `calculation_uploaded` (fill)
- If NotebookLM auth expires: daemon logs error, skips task, writes alert to `~/.local/share/tender-master/auth-error`
- If Convex unreachable: daemon logs error, continues polling
- If JSON output invalid: attempt repair with `repairTruncatedJson` logic, fail if unrepairable
- Stale tasks: Convex cron resets after 15 min, max 3 retries
- Timeout: `claude -p` configurable via `CLAUDE_TIMEOUT` env var (default 15 min)

## Testing Strategy

1. Verify `claude -p` + MCP works under `systemd-run --user`
2. Manual test: run `npx tsx process-analysis.ts <procurement_id>` on a known procurement
3. Compare output JSON with cloud pipeline output for same documents
4. Verify extracted actions (sliceForms, generateCalcExcel) produce identical results when called from both pipelines
5. Test toggle switching between cloud/local in UI
6. Test error rollback and stale task recovery
7. Test daemon start/stop/restart via systemd

## Dependencies

- Claude Max subscription (Opus 4.6)
- Google AI Pro subscription ($19.99/month) for NotebookLM
- `notebooklm-mcp` npm package (configured in claude MCP)
- `claude` CLI installed and authenticated
- Node.js 20+ (already installed for Next.js)
- systemd (Linux) for daemon management
