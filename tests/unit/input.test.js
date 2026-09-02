import { test } from "node:test";
import assert from "node:assert/strict";
import { input, pollInput, endFrame } from "../../src/core/input.js";

test("input carries head-look offset fields, default 0", () => {
    assert.equal(input.headYawOffset, 0);
    assert.equal(input.headPitchOffset, 0);
});

test("endFrame does not clear head offsets (they are absolute, not accumulated)", () => {
    input.headYawOffset = 0.4;
    input.headPitchOffset = -0.2;
    endFrame();
    assert.equal(input.headYawOffset, 0.4);
    assert.equal(input.headPitchOffset, -0.2);
    input.headYawOffset = 0;
    input.headPitchOffset = 0;
});

test("pollInput does not touch head offsets", () => {
    input.headYawOffset = 0.4;
    pollInput();
    assert.equal(input.headYawOffset, 0.4);
    input.headYawOffset = 0;
});
