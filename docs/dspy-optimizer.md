# DSPy classifier optimizer (Phase 5 — offline, not a live dependency)

Part of the [Smart Assistant](../README.md) project. The fifth of the
5-pillar rebuild (PydanticAI → OpenHands → Graphiti → Scrapling → DSPy).
Optimizes `agent-service/src/classify.py`'s tool-group classifier's few-shot
examples against real labeled data — **not** a runtime dependency of the
live chat path. `agent-service` never imports or calls anything in
`dspy-optimizer/`; this is a standalone tool a human runs on demand, inspects
the output of, and manually folds improvements back into `classify.py`'s
own prompt if they help.

## Why offline, not live

`classify.py`'s classifier already runs on every single chat turn via
PydanticAI + Ollama, hand-tuned with a hand-written system prompt and no
few-shot examples. DSPy's value here is entirely in *discovering* good
few-shot examples from labeled data (`BootstrapFewShot`) — a one-time (or
occasional) optimization pass, not something that needs to run per-request.
Adding `dspy` as a real dependency of `agent-service` would mean carrying an
extra LLM-orchestration framework in the live request path for a capability
that's only ever used offline — so it lives in its own directory with its
own venv (`dspy-optimizer/requirements.txt`), kept entirely separate.

## What it does

`dspy-optimizer/optimize_classifier.py`:
1. Defines a DSPy `Signature` mirroring `classify.py`'s actual category list
   and instructions (only `relevant_groups` — the one field
   [`scripts/eval-fixtures/v0-baseline.json`](../scripts/eval-fixtures/v0-baseline.json)
   has ground truth for; the other `ClassifierOutput` fields like
   `toolPolicy`/`memoryPolicy` aren't labeled there, so they're out of scope
   for this pass).
2. Splits the 25 labeled examples 70/30 into train/validation sets (fixed
   seed for reproducibility).
3. Evaluates the **zero-shot baseline** (exactly what `classify.py` runs
   today) against the validation set.
4. Runs `dspy.BootstrapFewShot` against the training set to discover good
   few-shot demonstrations.
5. Evaluates the **compiled (optimized)** program on the *same* validation
   set, and reports both exact-match and Jaccard (partial-credit)
   accuracy side by side.
6. Writes `results/compiled_classifier.json` (the discovered demos — the
   actual artifact to inspect/apply) and `results/report.json` (full
   per-example baseline vs. optimized comparison).

## Live-verified result (2026-09-26, qwen3:8b)

Baseline (zero-shot, matching live `classify.py` today): **87.5%** exact
match on the 8-example validation split — missed classifying
"what do you know about my car?" as `info`.

After `BootstrapFewShot` (4 bootstrapped + 4 labeled demos from the 17-example
training split): **100%** exact match on the same validation set — the demos
fixed exactly the case the baseline missed, without regressing any of the
7 it already got right.

## Running it

```bash
cd dspy-optimizer
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt   # or .venv/bin/... on Linux/Mac
.venv/Scripts/python.exe optimize_classifier.py
```

Requires Ollama reachable at `OLLAMA_HOST` (default `http://localhost:11434`)
with `CLASSIFIER_MODEL` (default `qwen3:8b`) already pulled — same model
`classify.py` uses live.

## Applying a result back to `classify.py`

This tool never writes to `agent-service/` itself. To act on a result:
1. Open `results/compiled_classifier.json`'s `demos` array — each entry is
   a clean `{message, relevant_groups}` pair.
2. Manually add the ones that look like genuinely useful, non-redundant
   examples to `classify.py`'s `_CLASSIFIER_SYSTEM_PROMPT` as a few-shot
   block (or wherever the eventual few-shot mechanism lands — `classify.py`
   doesn't have one yet, since the classifier has run zero-shot since it was
   built).
3. Re-run `scripts/eval-harness.mjs` against the live service afterward to
   confirm the change actually helps in the real pipeline, not just in this
   isolated harness.

As the fixture set grows past the current 25 examples (adding more of the
real edge cases the classifier gets wrong in production), re-running this
tool against the larger set is expected to keep finding better demos —
this is meant to be re-run occasionally, not a one-time exercise.
