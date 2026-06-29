---
name: implement
version: 1.0.0
description: >
  Implements a specific SDES entry (solution design) into working code.
  Reads linked requirements and decisions before writing any code.
  Adds SDES-XXX annotation in source files for traceability.
  Trigger on: "implementa SDES", "codifica", "sviluppa componente", "build sezione",
  "scrivi il codice per", "implementa sprint", or any request to write/modify
  components, pages, or integrations.
  IMPORTANT: never write code without first reading the linked SDES + REQs.
dependencies:
  - audit
requires:
  - docs/DESIGN-DOC.md
  - docs/requisiti/
  - docs/DECISIONS.md
  - src/
provides:
  - Source code with SDES-XXX annotations
  - E2E tests tagged [SDES-XXX]
---

# Implement

You are the developer for this project. Your job is to translate approved
SDES entries into clean, traceable Next.js code.

**The traceability chain you maintain:**

```
REQ-XXX → SDES-XXX → src/component:annotation → UAT-XXX
```

Every piece of code that implements a design choice must carry a `SDES-XXX` annotation.
This makes the build navigable: given any line of code, you can find why it exists.

---

## Before writing any code

1. **Read the SDES entry** in `docs/DESIGN-DOC.md`
   - Verify status = `approved` (never implement a `draft` SDES)
   - Extract: reqs, decisions, design choices, acceptance criteria
2. **Read the linked REQs** (only the referenced ones, not all 84)
3. **Read the linked Decisions** in `docs/DECISIONS.md`
4. **Check the wireframe** `docs/streams/s2-wireframe-homepage.md` for the relevant section
5. **Check existing code** in `src/` — don't recreate what already exists

---

## Annotation convention

Every component or function that implements a SDES entry gets an annotation comment:

### React/TSX components
```tsx
{/* SDES-001: section component-name */}
<span className="tagline">
  {dict.section.text}
</span>
```

### Functions / utilities
```typescript
// SDES-010: feature-name description
export async function featureFunction(data: FeatureData) {
  ...
}
```

### CSS / Tailwind classes
```tsx
{/* SDES-002: section headline */}
<h1 className="text-4xl font-bold tracking-tight text-gray-900">
  {dict.section.headline}
</h1>
```

### Rules for annotations
- One annotation per SDES entry — at the top of the component/function it implements
- Format: `SDES-XXX: [brief description]` — description helps developers without opening DESIGN-DOC
- If a single component implements multiple SDES, annotate each logical block separately
- Never annotate infrastructure code (layouts, providers, config) — only user-visible components

---

## Code standards

### Stack

> Leggere la sezione "Stack tecnologico" in CLAUDE.md per lo stack del progetto.
> Adattare le convenzioni di naming e le regole i18n al framework scelto.

### Database security (📌 D-016)

When creating new tables:
1. Always `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
2. Add explicit RLS policies using `get_my_studio_id()`
3. Add GRANT for `authenticated` role only (never `anon`)
4. Never expose `service_role` key to browser code
5. Use `SUPABASE_SERVICE_ROLE_KEY` only in server-side scripts

### Anti-patterns

> Leggere le decisioni attive in DECISIONS.md per anti-pattern specifici del progetto.

---

## After implementing

1. **Update SDES status** in `docs/DESIGN-DOC.md`:
   - Change `status: approved` → `status: implemented`
   - Add `implementation: src/path/to/file.tsx:ComponentName` to the SDES fields
2. **Write or update E2E test** (📌 D-014):
   - Every SDES must have at least one Playwright E2E test before moving to `implemented`
   - Tag the test title with `[SDES-XXX]`: `test("[SDES-001] timer starts on click", ...)`
   - Update `e2e:` field in DESIGN-DOC.md: `e2e: [e2e/file.spec.ts:SDES-XXX]`
3. **Run validate-traceability.py** to verify annotation is detected:
   ```bash
   python $SKILL_ROOT/audit/scripts/validate-traceability.py src/ docs/DESIGN-DOC.md
   ```
4. **Commit** with clear message referencing SDES and REQ:
   ```
   feat(hero): implement tagline claim (SDES-001, REQ-028)
   ```

---

## Commit message format

```
<type>(<scope>): <description> (SDES-XXX, REQ-XXX)

type: feat | fix | style | refactor | chore | i18n
scope: hero | services | contacts | form | blog | global | i18n | infra
```

Examples:
- `feat(section): implement component (SDES-001, REQ-001)`
- `fix(form): correct validation logic (SDES-010, REQ-044)`
- `fix(clienti): resolve RLS insert policy (SDES-015, fixes #7)` — closes GitHub issue
- `i18n(global): add translations for section (SDES-001)`

---

## Token efficiency rules

1. Read only the SDES entries relevant to the current task — not the whole DESIGN-DOC
2. Read only the referenced REQs — not all 84
3. Read existing `src/` files before writing new ones — avoid duplication
4. Run `validate-traceability.py` after each SDES implementation, not at the end of a batch
