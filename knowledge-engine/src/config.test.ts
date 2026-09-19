import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

test("loadConfig: throws without POSTGRES_PASSWORD", () => {
  assert.throws(() => loadConfig({}), /POSTGRES_PASSWORD is required/);
});

test("loadConfig: applies documented defaults", () => {
  const config = loadConfig({ POSTGRES_PASSWORD: "secret" });
  assert.equal(config.port, 3005);
  assert.equal(config.postgres.database, "research");
  assert.equal(config.ollamaHost, "http://ollama:11434");
  assert.equal(config.embeddingModel, "nomic-embed-text");
  assert.equal(config.minKeywordOverlap, 1);
});

test("loadConfig: env overrides win over defaults", () => {
  const config = loadConfig({
    POSTGRES_PASSWORD: "secret",
    PORT: "4000",
    RESEARCH_DB_NAME: "custom_db",
    KNOWLEDGE_EMBEDDING_MODEL: "other-model",
    KNOWLEDGE_MIN_KEYWORD_OVERLAP: "2",
  });
  assert.equal(config.port, 4000);
  assert.equal(config.postgres.database, "custom_db");
  assert.equal(config.embeddingModel, "other-model");
  assert.equal(config.minKeywordOverlap, 2);
});
