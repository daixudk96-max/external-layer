import { expect, test } from "bun:test";
import { classifyEmptyCompletion, isTransientError, withTransientRetry } from "../src/reliability";

test("transient families are recognized", () => {
  expect(isTransientError("ChatGPT ended the turn with 'Something went wrong'. Retry the turn.")).toBe(true);
  expect(isTransientError("ChatGPT stopped responding after the task started.")).toBe(true);
  expect(isTransientError("server_is_overloaded")).toBe(true);
  expect(isTransientError("session inspection timed out after 30000ms")).toBe(true);
  expect(isTransientError("invalid request: bad model")).toBe(false);
});

test("a transient failure is retried up to the budget and then surfaces", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const result = await withTransientRetry(async attempt => {
    attempts = attempt;
    if (attempt < 3) throw new Error("Something went wrong");
    return "ok";
  }, { limit: 5, sleep: async ms => { sleeps.push(ms); } });
  expect(result).toBe("ok");
  expect(attempts).toBe(3);
  expect(sleeps).toEqual([2000, 4000]);
  await expect(withTransientRetry(async () => { throw new Error("Something went wrong"); }, { limit: 2, sleep: async () => {} })).rejects.toThrow("Something went wrong");
});

test("a non-transient error is never retried", async () => {
  let calls = 0;
  await expect(withTransientRetry(async () => { calls += 1; throw new Error("400 invalid_request_error"); }, { limit: 5, sleep: async () => {} })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("an empty completed turn is classified instead of passing as success", () => {
  expect(classifyEmptyCompletion({ status: "completed", output: [] }).empty).toBe(true);
  expect(classifyEmptyCompletion({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] }).empty).toBe(false);
});
