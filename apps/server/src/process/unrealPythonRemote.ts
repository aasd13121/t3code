// @effect-diagnostics nodeBuiltinImport:off - speaks Unreal's built-in UDP discovery and TCP Python protocol.
// @effect-diagnostics globalTimersInEffect:off - cancellable Node socket callbacks own protocol retransmission and deadlines.
import * as NodeDgram from "node:dgram";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import { UnrealAssetOpenError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Message = Schema.Struct({
  version: Schema.Literal(1),
  magic: Schema.Literal("ue_py"),
  type: Schema.String,
  source: Schema.String,
  dest: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
});
const NodeInfo = Schema.Struct({ project_root: Schema.String });
const Reply = Schema.Struct({
  success: Schema.Boolean,
  output: Schema.Array(Schema.Struct({ output: Schema.String })),
});
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));
const decodeNodeInfo = Schema.decodeUnknownOption(NodeInfo);
const decodeReply = Schema.decodeUnknownOption(Reply);

interface RemoteInput {
  readonly projectRoot: string;
  readonly command: string;
  readonly group: string;
  readonly port: number;
  readonly caseInsensitive: boolean;
}

export const executeUnrealPython = Effect.fn("unrealAsset.executeUnrealPython")(
  (input: RemoteInput) =>
    Effect.callback<typeof Reply.Type, UnrealAssetOpenError>((resume) => {
      const localId = NodeCrypto.randomUUID();
      const udp = NodeDgram.createSocket({ type: "udp4", reuseAddr: true });
      const server = NodeNet.createServer();
      let socket: NodeNet.Socket | undefined;
      let remoteId: string | undefined;
      let listening = false;
      let done = false;
      let sawOtherProject = false;
      let received = Buffer.alloc(0);
      const normalize = (path: string) => {
        const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
        return input.caseInsensitive ? normalized.toLowerCase() : normalized;
      };
      const message = (type: string, data?: unknown) =>
        Buffer.from(
          JSON.stringify({
            version: 1,
            magic: "ue_py",
            type,
            source: localId,
            ...(remoteId ? { dest: remoteId } : {}),
            ...(data ? { data } : {}),
          }),
        );
      const closeUdp = () => {
        try {
          udp.close();
        } catch {
          /* A bind failure leaves no socket to close. */
        }
      };
      const cleanup = () => {
        clearInterval(ping);
        clearTimeout(deadline);
        socket?.destroy();
        server.close();
        if (listening && remoteId)
          udp.send(message("close_connection"), input.port, input.group, closeUdp);
        else closeUdp();
      };
      const fail = (reason: UnrealAssetOpenError["reason"]) => {
        if (done) return;
        done = true;
        cleanup();
        resume(Effect.fail(new UnrealAssetOpenError({ reason })));
      };
      const send = (type: string, data?: unknown) => {
        if (!listening || done) return;
        udp.send(message(type, data), input.port, input.group, (error) => {
          if (error) fail("editor-unavailable");
        });
      };
      const ping = setInterval(() => {
        if (!remoteId) send("ping");
      }, 1000);
      const deadline = setTimeout(
        () => fail(sawOtherProject && !remoteId ? "project-mismatch" : "editor-unavailable"),
        10000,
      );
      udp.on("error", () => fail("editor-unavailable"));
      server.on("error", () => fail("editor-unavailable"));
      server.on("connection", (connection) => {
        if (done || !remoteId || socket || connection.remoteAddress !== "127.0.0.1") {
          connection.destroy();
          return;
        }
        socket = connection;
        connection.on("error", () => fail("editor-unavailable"));
        connection.on("end", () => {
          if (!done) fail("open-failed");
        });
        connection.on("data", (chunk: Buffer) => {
          if (done) return;
          if (received.length + chunk.length > 256 * 1024) {
            fail("open-failed");
            return;
          }
          received = Buffer.concat([received, chunk]);
          const parsed = decodeMessage(received.toString("utf8"));
          if (parsed._tag === "None") return; // TCP may split JSON at any byte, including inside UTF-8.
          const reply = parsed.value;
          if (
            reply.source !== remoteId ||
            reply.dest !== localId ||
            reply.type !== "command_result"
          ) {
            fail("open-failed");
            return;
          }
          const result = decodeReply(reply.data);
          if (result._tag === "None") {
            fail("open-failed");
            return;
          }
          done = true;
          cleanup();
          resume(Effect.succeed(result.value));
        });
        connection.write(
          message("command", {
            command: input.command,
            unattended: true,
            exec_mode: "ExecuteFile",
          }),
        );
      });
      udp.on("message", (bytes, sender) => {
        if (done || remoteId || sender.address !== "127.0.0.1") return;
        const parsed = decodeMessage(bytes.toString("utf8"));
        if (parsed._tag === "None") return;
        const reply = parsed.value;
        if (
          reply.type !== "pong" ||
          reply.source === localId ||
          (reply.dest && reply.dest !== localId)
        )
          return;
        const node = decodeNodeInfo(reply.data);
        if (node._tag === "None") return;
        if (normalize(node.value.project_root) !== normalize(input.projectRoot)) {
          sawOtherProject = true;
          return;
        }
        remoteId = reply.source;
        clearInterval(ping);
        const address = server.address();
        if (!address || typeof address === "string") {
          fail("editor-unavailable");
          return;
        }
        send("open_connection", { command_ip: "127.0.0.1", command_port: address.port });
      });
      server.listen(0, "127.0.0.1", () => {
        if (done) return;
        udp.bind(input.port, "127.0.0.1", () => {
          if (done) {
            closeUdp();
            return;
          }
          listening = true;
          try {
            udp.setMulticastInterface("127.0.0.1");
            udp.setMulticastTTL(0);
            udp.setMulticastLoopback(true);
            udp.addMembership(input.group, "127.0.0.1");
            send("ping");
          } catch {
            fail("editor-unavailable");
          }
        });
      });
      return Effect.sync(() => {
        if (!done) {
          done = true;
          cleanup();
        }
      });
    }),
);
