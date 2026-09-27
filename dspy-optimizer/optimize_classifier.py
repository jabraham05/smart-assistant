"""Offline DSPy optimization workflow for agent-service/src/classify.py's
tool-group classifier - NOT a runtime dependency of the live chat path (see
task #32: "likely an offline script/service... not a runtime dependency in
the live chat path"). Run manually, on demand, against the real Postgres-free
fixture set (scripts/eval-fixtures/v0-baseline.json); its output is a
compiled DSPy program plus the few-shot demos it discovered, for a human to
manually fold into classify.py's real prompt if they improve accuracy.

Mirrors classify.py's actual category list and classifier instructions
closely (not a "simplified" toy version) so the optimized few-shot examples
are meaningful if copied back into the real service. Only relevant_groups is
scored against ground truth - v0-baseline.json only labels expectedGroups,
not the other ClassifierOutput fields (toolPolicy/memoryPolicy/etc.), so
those aren't part of the metric here.

Usage: .venv/Scripts/python.exe optimize_classifier.py
Requires Ollama reachable at OLLAMA_HOST (default http://localhost:11434)
with the classifier model already pulled (default qwen3:8b).
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path

import dspy

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
CLASSIFIER_MODEL = os.environ.get("CLASSIFIER_MODEL", "qwen3:8b")
FIXTURE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "eval-fixtures" / "v0-baseline.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "results"

TOOL_GROUPS = [
    "media",
    "scheduling",
    "info",
    "self-growth",
    "dashboard",
    "web",
    "knowledge",
    "research",
    "goals",
]

# Distilled from agent-service/src/classify.py's _CLASSIFIER_SYSTEM_PROMPT -
# same category definitions, trimmed to just the category list (the policy
# fields aren't scored here, so their instructions are omitted to keep the
# signature focused on what's actually being optimized).
_INSTRUCTIONS = (
    "Classify which capability categories (zero, one, or a few) might be needed to respond to the "
    "user's message. Categories: 'media' (music/Spotify playback control), 'scheduling' (calendar "
    "events), 'info' (weather, or recalling facts/preferences ABOUT THE USER THEMSELVES specifically "
    "- their traits, likes, past statements - never a document, manual, or reference material), "
    "'self-growth' (proposing a new skill/tool, starting a coding task on a repo, checking on a "
    "coding task's progress, or proposing a longer-term coding project for approval before work "
    "starts), 'dashboard' (moving, resizing, showing, or hiding widgets on the smart-mirror "
    "dashboard), 'web' (searching the live web for current information, news, or facts that could "
    "have changed since training, OR looking something up online in general such as finding "
    "products, links, or recommendations), 'knowledge' (looking up or searching within a specific "
    "document/manual/guide Amy has stored, or anything else already saved in Amy's knowledge base/"
    "past research, or saving a specific web page for later recall), 'research' (starting in-depth "
    "background research on a topic not already known, that should be saved for later, OR checking "
    "on/asking about findings from research that may have already happened), 'goals' (creating, "
    "listing, updating, or checking progress on the user's persistent personal objectives). Most "
    "messages need none at all - only include a category if it's genuinely likely needed."
)


class ClassifyGroups(dspy.Signature):
    __doc__ = _INSTRUCTIONS

    message: str = dspy.InputField(desc="the user's chat message")
    relevant_groups: list[str] = dspy.OutputField(
        desc=f"subset of {TOOL_GROUPS}, empty list if none apply"
    )


def load_examples() -> list[dspy.Example]:
    raw = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    examples = []
    for row in raw:
        ex = dspy.Example(message=row["message"], relevant_groups=row["expectedGroups"]).with_inputs("message")
        examples.append(ex)
    return examples


def groups_match(example: dspy.Example, prediction, trace=None) -> bool:
    expected = set(example.relevant_groups)
    predicted = set(getattr(prediction, "relevant_groups", []) or [])
    return expected == predicted


def jaccard(example: dspy.Example, prediction) -> float:
    expected = set(example.relevant_groups)
    predicted = set(getattr(prediction, "relevant_groups", []) or [])
    if not expected and not predicted:
        return 1.0
    if not expected or not predicted:
        return 0.0
    return len(expected & predicted) / len(expected | predicted)


def evaluate(program, examples: list[dspy.Example]) -> tuple[float, float, list[dict]]:
    exact = 0
    jaccard_total = 0.0
    rows = []
    for ex in examples:
        try:
            pred = program(message=ex.message)
        except Exception as e:
            rows.append({"message": ex.message, "expected": ex.relevant_groups, "predicted": None, "error": str(e)})
            continue
        is_exact = groups_match(ex, pred)
        j = jaccard(ex, pred)
        exact += int(is_exact)
        jaccard_total += j
        rows.append(
            {
                "message": ex.message,
                "expected": ex.relevant_groups,
                "predicted": list(getattr(pred, "relevant_groups", []) or []),
                "exact": is_exact,
                "jaccard": round(j, 3),
            }
        )
    n = len(examples)
    return exact / n, jaccard_total / n, rows


def main():
    lm = dspy.LM(f"openai/{CLASSIFIER_MODEL}", api_base=f"{OLLAMA_HOST}/v1", api_key="ollama")
    dspy.configure(lm=lm)

    all_examples = load_examples()
    print(f"Loaded {len(all_examples)} labeled examples from {FIXTURE_PATH}")

    rng = random.Random(42)
    shuffled = all_examples[:]
    rng.shuffle(shuffled)
    split = int(len(shuffled) * 0.7)
    train_set, val_set = shuffled[:split], shuffled[split:]
    print(f"Split: {len(train_set)} train, {len(val_set)} val (seed=42)")

    baseline = dspy.Predict(ClassifyGroups)
    print("\n=== Baseline (zero-shot) on validation set ===")
    baseline_exact, baseline_jaccard, baseline_rows = evaluate(baseline, val_set)
    print(f"Exact-match accuracy: {baseline_exact:.1%}  |  Jaccard (partial credit): {baseline_jaccard:.1%}")

    print("\n=== Running BootstrapFewShot optimizer against training set ===")
    optimizer = dspy.BootstrapFewShot(metric=groups_match, max_bootstrapped_demos=4, max_labeled_demos=8)
    compiled = optimizer.compile(dspy.Predict(ClassifyGroups), trainset=train_set)

    print("\n=== Compiled (optimized) program on the SAME validation set ===")
    compiled_exact, compiled_jaccard, compiled_rows = evaluate(compiled, val_set)
    print(f"Exact-match accuracy: {compiled_exact:.1%}  |  Jaccard (partial credit): {compiled_jaccard:.1%}")

    print("\n=== Result ===")
    print(f"Baseline : exact={baseline_exact:.1%} jaccard={baseline_jaccard:.1%}")
    print(f"Optimized: exact={compiled_exact:.1%} jaccard={compiled_jaccard:.1%}")

    OUTPUT_DIR.mkdir(exist_ok=True)
    compiled.save(str(OUTPUT_DIR / "compiled_classifier.json"))
    report = {
        "model": CLASSIFIER_MODEL,
        "train_size": len(train_set),
        "val_size": len(val_set),
        "baseline": {"exact": baseline_exact, "jaccard": baseline_jaccard, "rows": baseline_rows},
        "optimized": {"exact": compiled_exact, "jaccard": compiled_jaccard, "rows": compiled_rows},
    }
    (OUTPUT_DIR / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nWrote compiled program to {OUTPUT_DIR / 'compiled_classifier.json'}")
    print(f"Wrote full report to {OUTPUT_DIR / 'report.json'}")


if __name__ == "__main__":
    main()
