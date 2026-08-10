// Unit tests for src/tools.ts model-switch contract guards (D-118, GTD 41853607).
// Run with: npx tsx --test tests/model-switch-guards.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { isHaikuModelSlug, buildHaikuAutopilotBlock, buildModelCostNotice } from "../src/tools.ts";

test("isHaikuModelSlug: matches haiku aliases and full IDs, case-insensitive", () => {
  assert.equal(isHaikuModelSlug("haiku"), true);
  assert.equal(isHaikuModelSlug("Haiku"), true);
  assert.equal(isHaikuModelSlug("claude-haiku-4-5-20251001"), true);
  assert.equal(isHaikuModelSlug("sonnet"), false);
  assert.equal(isHaikuModelSlug("opus"), false);
});

test("buildHaikuAutopilotBlock: rejects haiku while mode=autopilot", () => {
  const msg = buildHaikuAutopilotBlock({ requestedModel: "haiku", targetMode: "autopilot" });
  assert.match(msg ?? "", /Haiku/);
  assert.match(msg ?? "", /autopilot/);
});

test("buildHaikuAutopilotBlock: allows haiku outside autopilot (interactive/chat/dream/null)", () => {
  for (const mode of ["interactive", "chat", "dream", null]) {
    const msg = buildHaikuAutopilotBlock({ requestedModel: "haiku", targetMode: mode });
    assert.equal(msg, undefined, `mode=${mode} must not block`);
  }
});

test("buildHaikuAutopilotBlock: allows non-haiku models in autopilot", () => {
  for (const model of ["sonnet", "opus", "fable", "claude-sonnet-5"]) {
    const msg = buildHaikuAutopilotBlock({ requestedModel: model, targetMode: "autopilot" });
    assert.equal(msg, undefined, `model=${model} must not block`);
  }
});

test("buildModelCostNotice: flags an upgrade (sonnet -> opus)", () => {
  const notice = buildModelCostNotice({ currentModel: "claude-sonnet-5", requestedModel: "opus" });
  assert.match(notice ?? "", /claude-sonnet-5/);
  assert.match(notice ?? "", /opus/);
});

test("buildModelCostNotice: no notice on downgrade or lateral move", () => {
  assert.equal(buildModelCostNotice({ currentModel: "opus", requestedModel: "sonnet" }), undefined);
  assert.equal(buildModelCostNotice({ currentModel: "sonnet", requestedModel: "fable" }), undefined);
  assert.equal(buildModelCostNotice({ currentModel: "sonnet", requestedModel: "sonnet" }), undefined);
});

test("buildModelCostNotice: no notice when either model is unrecognized (unknown tier)", () => {
  assert.equal(buildModelCostNotice({ currentModel: null, requestedModel: "opus" }), undefined);
  assert.equal(buildModelCostNotice({ currentModel: "sonnet", requestedModel: "some-future-model" }), undefined);
});
