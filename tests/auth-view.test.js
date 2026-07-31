import test from "node:test";
import assert from "node:assert/strict";
import { privateViewDecision, classroomAuthRecoveryModel } from "../auth-view.js";

test("private views require an authenticated session", () => {
  assert.deepEqual(privateViewDecision("kb", null), {
    allowed: false,
    fallback: "planner",
    message: "Sign in with Google to open your private Knowledge Base.",
  });
});

test("authenticated users may open the private Knowledge Base", () => {
  assert.deepEqual(privateViewDecision("kb", "token"), {
    allowed: true,
    fallback: null,
    message: "",
  });
});

test("public shell views keep their existing routing behavior", () => {
  assert.deepEqual(privateViewDecision("planner", null), {
    allowed: true,
    fallback: null,
    message: "",
  });
});

test("Classroom 400 and 403 responses require a local session reset and account chooser", () => {
  assert.deepEqual(classroomAuthRecoveryModel(400), {
    resetSession: true,
    prompt: "select_account",
  });
  assert.deepEqual(classroomAuthRecoveryModel(403), {
    resetSession: true,
    prompt: "select_account",
  });
});

test("non-account Classroom failures do not force an account switch", () => {
  assert.deepEqual(classroomAuthRecoveryModel(401), {
    resetSession: false,
    prompt: null,
  });
});
