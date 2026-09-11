import { expect, test } from "bun:test";
import { chatCompletionsToResponses, responsesToChatCompletions } from "../src/chat-completions";
import { runToolLoop } from "../src/tool-loop";

test("the tool loop feeds function results back and finishes with text", async () => {
  const rounds: number[] = [];
  const executed: string[] = [];
  const outcome = await runToolLoop({ input: "list files", tools: [{ type: "function", name: "exec_command" }], maxRounds: 5 }, {
    callModel: async round => {
      rounds.push(round);
      if (round === 1) return { functionCalls: [{ callId: "call_1", name: "exec_command", args: { cmd: "ls" } }], rawResponse: {} };
      return { functionCalls: [], text: "done", rawResponse: {} };
    },
    executeTool: async name => { executed.push(name); return { output: "file-a\nfile-b" }; },
  });
  expect(outcome.rounds).toBe(2);
  expect(outcome.text).toBe("done");
  expect(outcome.toolResults[0]?.callId).toBe("call_1");
  expect(executed).toEqual(["exec_command"]);
  expect(rounds).toEqual([1, 2]);
});

test("maxRounds stops a runaway tool loop", async () => {
  const outcome = await runToolLoop({ input: "x", maxRounds: 2 }, {
    callModel: async round => ({ functionCalls: [{ callId: `call_${round}`, name: "exec_command", args: {} }], rawResponse: {} }),
    executeTool: async () => ({ output: "again" }),
  });
  expect(outcome.rounds).toBe(2);
  expect(outcome.toolResults.length).toBe(2);
});

test("chat-completions conversions preserve roles and tool calls", () => {
  const responsesShape = chatCompletionsToResponses({ model: "chatgpt-web/latest", messages: [{ role: "user", content: "hi" }] });
  expect(JSON.stringify(responsesShape)).toContain("hi");
  const chat = responsesToChatCompletions({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }] }, "chatgpt-web/latest");
  const choices = chat.choices as Array<{ message?: { content?: string } }>;
  expect(choices[0]?.message?.content).toBe("hello");
});
