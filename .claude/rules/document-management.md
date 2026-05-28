# Document Management

Blueprint manages three document types for this project. Watch for opportunities to capture decisions as structured documents.

## Document Types & Locations

| Type | Location | Use When |
|------|----------|----------|
| PRD | `docs/blueprint/prds/` | Describing what to build and why — features, requirements, user stories |
| ADR | `docs/blueprint/adrs/` | Recording significant architecture or design decisions with trade-off analysis |
| PRP | `docs/prps/` | Creating implementation-ready task packages for a specific change |
| TRP | `docs/trps/` | Test regression plans derived from git history |

## Automatic Decision Detection

Watch for these signals during conversations and prompt to capture them:

### Architecture Decisions → ADR
- Choosing between implementation approaches (e.g., multi-file vs single-file JS)
- Deciding on a data schema or API contract
- Trade-off discussions about dependencies, performance, or compatibility
- "We decided to..." or "We'll go with..." followed by a rationale

### Feature Requirements → PRD
- Describing new capabilities or enhancements
- Defining scope boundaries ("this pack will/won't...")
- Discussing user-facing behavior changes

### Implementation Plans → PRP
- Step-by-step plans for a specific change
- Work breakdown for a feature or fix

## Prompting Behavior

When a conversation contains a documentable decision, suggest:

> "This looks like an architecture decision worth capturing. Would you like me to create an ADR at `docs/blueprint/adrs/NNNN-<slug>.md`?"

Use `/blueprint:derive-adr`, `/blueprint:derive-prd`, or `/blueprint:prp-create` to generate documents from the conversation.

## Naming Conventions

- ADRs: `docs/blueprint/adrs/NNNN-kebab-case-title.md` (e.g., `0001-multi-file-js-architecture.md`)
- PRDs: `docs/blueprint/prds/kebab-case-title.md`
- PRPs: `docs/prps/kebab-case-title.md`
- TRPs: `docs/trps/NNN-kebab-case-title.md`

## What Already Exists

- `CLAUDE.md` — primary project context for Claude; update with `/blueprint:claude-md`
- `RELEASE-CHECKLIST.md` — release process reference; leave in place
