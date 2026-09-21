import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSkillsCatalog } from "./skills-catalog.js";

test("formatSkillsCatalog returns empty string with no skills", () => {
  assert.equal(formatSkillsCatalog([]), "");
});

test("formatSkillsCatalog drops rows with no name", () => {
  assert.equal(
    formatSkillsCatalog([{ name: "", description: "d", instructions: "i" }]),
    "",
  );
});

test("formatSkillsCatalog joins multiple skills as markdown blocks", () => {
  const text = formatSkillsCatalog([
    { name: "skill-one", description: "desc one", instructions: "do this" },
    { name: "skill-two", description: "desc two", instructions: "do that" },
  ]);
  assert.equal(
    text,
    "## skill-one\ndesc one\n\ndo this\n\n## skill-two\ndesc two\n\ndo that",
  );
});
