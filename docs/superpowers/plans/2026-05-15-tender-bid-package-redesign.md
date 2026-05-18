# Tender Bid Package Redesign Plan

> **Context for next session:** This plan captures the intended redesign of Tender Master around the `tender-bid-package` skill logic. Start here before changing code.

**Goal:** Turn Tender Master from a form filler into a bid-package preparation system: extract procurement requirements first, build a structured application package, show missing documents and risks, then fill only the forms that the documentation actually requires.

**Product direction:** The user liked the output style of `$tender-bid-package`. Preserve that logic in the service: source documentation is the authority; participant data must come from the selected profile and sourced documents; uncertainty must be visible as missing items or risk notes.

**Current state:** Tender Master already has useful infrastructure:

- `src/lib/server/processor.ts` parses DOCX/XLSX/PDF, extracts items/forms, generates calculation files, and fills forms.
- `scripts/local-processor.mts` is likely the primary runtime processor and must be updated alongside `src/lib/server/processor.ts`.
- `convex/schema.ts` stores procurements, uploaded files, extracted items/forms, calculation data, and generated files.
- `src/lib/profiles.ts` hardcodes two IP profiles: `boltinov` and `pikhenek`.
- `src/app/procurement/[id]/page.tsx` is currently a linear UI: upload/analyze -> calculation -> fill forms.

**Key redesign:** Add a planning layer between document analysis and form filling.

Current flow:

```text
Upload docs -> extract items/forms -> make calculation -> fill found forms -> flat ZIP
```

Target flow:

```text
Upload docs
-> preserve source_docs
-> extract tender card
-> extract application requirements
-> build bid package plan by sections
-> collect/validate participant profile documents
-> generate/fill required documents
-> validate anonymity/pricing/completeness
-> export structured package + memo
```

---

## Tender-Bid-Package Rules To Preserve

- Source documents are the authority. Do not generate a document just because the system can.
- Read the information card and application composition section before drafting.
- Search for: `первая часть`, `вторая часть`, `состав заявки`, `Форма`, `коммерческое предложение`, `критерии`, `обеспечение`, `СМП`, `персональных данных`, `страна происхождения`.
- For two-part tenders, the first part must be anonymous unless documentation says otherwise.
- Do not include participant name, INN, address, contacts, logo, bank details, signature, seal, file metadata, or price in `first_part`.
- Price offer must not exceed buyer line limits unless documentation explicitly allows it.
- VAT/tax wording must match the participant profile and tender form.
- Missing passport data, powers of attorney, staff certificates, licenses, registry extracts, and other evidence must be listed as missing, not invented.
- Final output must tell the user exactly what is ready, what is missing, what is risky, and what to upload where.

---

## Target Data Model

### Procurement/Tender Card

Add structured tender metadata, either in `procurements` or a separate `tenderCards` table:

- customer name
- procurement number
- subject
- platform URL/name
- publication date
- submission deadline and timezone
- result date if found
- law/regime: 44-FZ, 223-FZ, commercial, unknown
- lots
- NMCK/max contract value
- currency
- payment terms
- delivery/work period
- guarantees
- application security
- contract security
- SMP/SME flag
- evaluation criteria
- key risks

### Application Requirements

Add `applicationRequirements` or equivalent:

- procurementId
- section: `first_part`, `second_part`, `price_offer`, `required_docs`, `platform_actions`
- requirement text
- source file
- source coordinates/block/page/sheet when available
- required document/form name
- required/optional/not_applicable
- status: `planned`, `prepared`, `missing`, `not_applicable`, `risk`
- risk note

### Package Artifacts

Extend generated files or add `packageArtifacts`:

- procurementId
- section: `source_docs`, `first_part`, `second_part`, `price_offer`, `required_docs`, `root`
- storageId
- fileName
- artifactType: `source`, `filled_form`, `generated_doc`, `memo`, `inventory`, `risk_report`, `package_zip`
- profileId/participantProfileId
- validation status

### Participant Profiles

Replace hardcoded profile enum long-term with `participantProfiles`:

- type: `ip | ooo | ao | other`
- full name, short name
- INN, KPP, OGRN/OGRNIP, OKPO, OKTMO, OKVED
- legal/actual/mailing addresses
- signatory and authority basis
- bank details
- tax regime and VAT status
- contacts
- licenses, staff, experience, certificates
- source documents and freshness dates

Short-term compatibility: keep `boltinov | pikhenek`, but introduce a normalized adapter that exposes the skill-style participant schema.

---

## Target Package Layout

Generated ZIP should not be flat. It should contain:

```text
source_docs/
first_part/
second_part/
price_offer/
required_docs/
Резюме_закупки.md
Опись_пакета.docx
Памятка_по_подаче.md
```

`Резюме_закупки.md` should include tender card, deadlines, price/security/payment terms, evaluation criteria, and risks.

`Опись_пакета.docx` should list all generated/attached files by upload section.

`Памятка_по_подаче.md` should list platform-only actions: price fields, checkboxes/declarations, upload slots, EDS signing, and final checks.

---

## Implementation Plan

### Task 1: Add Bid Package Extraction Schema

**Files:**
- Modify: `src/lib/server/openaiSchemas.ts`
- Modify: `src/lib/server/processor.ts`
- Modify: `scripts/local-processor.mts`
- Add tests around extraction merge if practical.

- [ ] Add `TenderCard`, `ApplicationRequirement`, `BidPackagePlan`, `MissingItem`, and `RiskNote` TypeScript types.
- [ ] Add structured output schema for `bid_package_analysis`.
- [ ] Keep current item/form extraction temporarily, but add package extraction alongside it.
- [ ] Update extraction prompt with the tender-bid-package search rules.
- [ ] Make extraction return source references for requirements where possible.

### Task 2: Persist Package Plan In Convex

**Files:**
- Modify: `convex/schema.ts`
- Modify: `convex/procurements.ts`
- Modify: `convex/localApi.ts`
- Modify generated Convex types after schema change.

- [ ] Add tables or fields for tender card, application requirements, missing items, and risk notes.
- [ ] Add mutations to clear and save package-analysis data per procurement.
- [ ] Ensure deleting a procurement also deletes package-plan rows.
- [ ] Keep existing tables intact to avoid breaking current fill flow.

### Task 3: Show Package Plan In UI

**Files:**
- Modify: `src/app/procurement/[id]/page.tsx`
- Add components under `src/components/` if useful.

- [ ] Add a “Карточка закупки” block after analysis.
- [ ] Add sectioned application plan: first part, second part, price offer, required docs, platform actions.
- [ ] Show status chips: ready, missing, risk, not applicable.
- [ ] Show “missing before submission” list prominently.
- [ ] Keep the current calculation and filling sections, but make them subordinate to the package plan.

### Task 4: Rework Form Selection Around Requirements

**Files:**
- Modify: `src/lib/server/processor.ts`
- Modify: `scripts/local-processor.mts`
- Modify: `convex/formFilling.ts`
- Modify: `src/app/procurement/[id]/page.tsx`

- [ ] Map extracted forms to package requirements instead of presenting all found forms equally.
- [ ] Skip forms that are not required, unless user manually includes them.
- [ ] Mark forms as prepared/missing/not applicable against their requirement.
- [ ] Keep collective-participant skip logic, but explain it as a package decision.

### Task 5: First-Part Anonymity Validator

**Files:**
- Add: `src/lib/server/packageValidation.ts`
- Add tests under `tests/`.
- Integrate into `processor.ts` and `scripts/local-processor.mts`.

- [ ] Build participant identifier list from active profile: full/short name, FIO, INN, OGRN/OGRNIP, address, phone, email, bank account.
- [ ] Scan `first_part` generated files text and filenames.
- [ ] Scan for price values in first part when first part must be anonymous/no-price.
- [ ] Report findings as blocking risks, not silent warnings.

### Task 6: Price Offer Validator

**Files:**
- Add or extend: `src/lib/server/packageValidation.ts`
- Add tests.

- [ ] Compare every generated offer line with extracted buyer max line price.
- [ ] Flag missing price rows or row-count mismatches.
- [ ] Verify VAT/tax wording against participant profile.
- [ ] Add platform-price-field notes to submission memo.

### Task 7: Structured Package Export

**Files:**
- Modify: `src/components/generated-files-list.tsx`
- Add server/package builder module if needed.

- [ ] Replace flat `Заявка.zip` with sectioned ZIP layout.
- [ ] Put uploaded originals or references in `source_docs/`.
- [ ] Put filled/generated docs into `first_part`, `second_part`, `price_offer`, `required_docs`.
- [ ] Generate root `Резюме_закупки.md`, `Опись_пакета.docx`, and `Памятка_по_подаче.md`.
- [ ] Name files safely and consistently.

### Task 8: Participant Profile Refactor

**Files:**
- Modify: `convex/schema.ts`
- Modify: `src/lib/profiles.ts`
- Modify: `src/components/header.tsx`
- Modify places typed as `boltinov | pikhenek`.

- [ ] Add normalized participant profile interface matching the skill checklist.
- [ ] Add adapter for existing static profiles.
- [ ] Later: persist participant profiles and profile documents in Convex.
- [ ] Later: allow adding/updating ООО/АО/ИП without code changes.

### Task 9: Memo And Risk UX

**Files:**
- Add memo generator module.
- Modify procurement page.

- [ ] Generate `Резюме_закупки.md` from persisted tender card and risks.
- [ ] Generate upload memo with exact platform actions.
- [ ] Show final readiness state: ready / ready with risks / blocked by missing documents.
- [ ] Final screen must answer: where the package is, what is ready, what must be checked before submission.

---

## Suggested First Coding Session

Do not start by rewriting UI or filling logic. Start with the narrowest useful change:

1. Add `BidPackagePlan` types and schema in `openaiSchemas.ts`.
2. Add a new package-analysis prompt based on the tender-bid-package rules.
3. Run package extraction alongside current extraction in `processAnalysis`.
4. Persist tender card + requirements + missing/risk lists.
5. Show the extracted plan in the procurement page.

This gives immediate product value without risking the current form-filling pipeline.

---

## Acceptance Criteria For MVP

- After uploading procurement docs and running analysis, the user sees a tender card.
- The user sees required application sections, not just a list of detected forms.
- Missing documents are explicit.
- Risks are explicit.
- First/second part distinction is captured when found in documentation.
- Existing calculation and form filling still work.
- No participant data is invented.
- The final answer/export tells the user what to upload and what remains risky.

