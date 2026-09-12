/** Incremental SSE observation. Bytes are never rewritten; all state transitions use
 * complete data records, not substring matches retained from a previous network chunk. */
export interface SseEvent {
  type: string;
  data?: Record<string, unknown>;
}

export class SseEvents {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private event = "";
  private data = "";

  push(bytes: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    const output: SseEvent[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (line.startsWith("event:")) { this.event = line.slice(6).trim(); this.data = ""; }
      else if (line.startsWith("data:")) {
        this.data += (this.data ? "\n" : "") + line.slice(5).trimStart();
        if (this.data.trim() === "[DONE]") {
          output.push({ type: "[DONE]" }); this.event = ""; this.data = "";
        } else {
          try {
            const value: unknown = JSON.parse(this.data);
            if (value && typeof value === "object" && !Array.isArray(value)) {
              const data = value as Record<string, unknown>;
              output.push({ type: typeof data.type === "string" ? data.type : this.event, data });
            }
            this.event = ""; this.data = "";
          } catch { /* wait for a multi-data-line JSON value */ }
        }
      } else if (line === "") { this.event = ""; this.data = ""; }
    }
    if (this.buffer.length + this.data.length > 16 * 1024 * 1024) throw new Error("upstream SSE record exceeds 16 MiB");
    return output;
  }
}

export function terminalEvent(event: SseEvent): boolean {
  return ["response.completed", "response.failed", "response.incomplete", "error", "[DONE]"].includes(event.type);
}

export function progressEvent(event: SseEvent): boolean {
  if (terminalEvent(event)) return true;
  if (event.type.endsWith(".delta")) return typeof event.data?.delta === "string" && event.data.delta.length > 0;
  return event.type.includes("function_call") || event.type.includes("custom_tool_call")
    || (event.type === "response.output_item.added" && typeof event.data?.item === "object");
}
