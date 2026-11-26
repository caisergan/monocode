// MonoCode's Master tool for Pi. MonoCode writes this file and loads it with
// `pi --no-mcp -e <file> --tools read,grep,find,ls,monocode`, so Master has
// read tools and this one tool, and no shell or edit tool. Each call is one
// authenticated request to the running app over its local bridge; the
// credentials come from the environment MonoCode gives the Pi process.
import { connect } from "node:net";

const HELP: string = __MONOCODE_HELP__;

function call(action: string, input: unknown, requestId: string, signal?: AbortSignal): Promise<string> {
  const endpoint = process.env.MONOCODE_APP_ENDPOINT ?? "";
  const token = process.env.MONOCODE_APP_TOKEN ?? "";
  const session = Number(process.env.MONOCODE_APP_SESSION ?? "");
  const split = endpoint.lastIndexOf(":");
  if (!token || split < 0 || !Number.isSafeInteger(session)) {
    return Promise.reject(new Error("MonoCode app access is not available in this session"));
  }
  return new Promise((resolve, reject) => {
    const socket = connect({ host: endpoint.slice(0, split), port: Number(endpoint.slice(split + 1)) });
    let reply = "";
    const abort = () => {
      socket.destroy();
      reject(new Error("Cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ session, token, request_id: requestId, action, input }) + "\n");
    });
    socket.on("data", (chunk: string) => {
      reply += chunk;
    });
    socket.on("error", (error: Error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    socket.on("close", () => {
      signal?.removeEventListener("abort", abort);
      resolve(reply.trim());
    });
  });
}

export default function (pi: any) {
  pi.registerTool({
    name: "monocode",
    label: "MonoCode",
    description: `Run a MonoCode Master action. Pass the action name and its JSON input. Retry an uncertain change with the same requestId and identical input.\n\n${HELP}`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "For example master.sessions or master.plan" },
        input: { type: "object", description: "The action's input object" },
        requestId: { type: "string", maxLength: 128, description: "Reuse when retrying an uncertain change" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      const requestId = typeof params.requestId === "string" && params.requestId ? params.requestId : `pi-${toolCallId}`;
      const reply = await call(params.action, params.input ?? {}, requestId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128), signal);
      let parsed: any;
      try {
        parsed = JSON.parse(reply);
      } catch {
        throw new Error(reply || "MonoCode did not answer");
      }
      if (parsed.ok === false) {
        throw new Error(String(parsed.error ?? "MonoCode refused the action"));
      }
      return { content: [{ type: "text", text: JSON.stringify(parsed.result ?? parsed) }], details: {} };
    },
  });
}
