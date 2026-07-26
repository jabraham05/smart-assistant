#!/usr/bin/env node
// One-off bootstrap: seeds Honcho peer cards before dreaming has had a
// chance to discover facts organically. Safe to re-run (set_card replaces
// the whole card each time, it doesn't merge).
// Usage: HONCHO_API_KEY=... node scripts/set-peer-cards.mjs

const apiKey = process.env.HONCHO_API_KEY;
if (!apiKey) {
  console.error("Set HONCHO_API_KEY in the environment");
  process.exit(1);
}

const workspaceId = process.env.HONCHO_WORKSPACE_ID || "smart-assistant";
const baseUrl = `https://api.honcho.dev/v3/workspaces/${workspaceId}`;

// user's own card: durable facts about the user.
const userCard = [
  "Name: John Abraham",
  "Age: 21 (born June 4, 2005)",
  "Recently graduated from the University of Washington with a CS degree",
  "Currently looking for a job",
];

// user's directional card for amy: standing instructions for Amy's behavior,
// from the user's perspective (target=amy).
const userCardForAmy = [
  "GOAL: Assist the user with everything possible",
  "PRIORITY: Make the user the top priority",
  "PRIORITY: Focus on advancing and helping the user",
  "TRAIT: Eager to grow and learn new things that help the user",
  "TRAIT: Butler-type personality",
];

async function setCard(peerId, card, target) {
  const url = `${baseUrl}/peers/${peerId}/card${target ? `?target=${target}` : ""}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ peer_card: card }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PUT ${url} failed: ${res.status} ${body}`);
  }
  console.log(`Set card for peer=${peerId}${target ? ` target=${target}` : ""} (${card.length} facts)`);
}

await setCard("user", userCard);
await setCard("user", userCardForAmy, "amy");
