import { Socket } from "node:net";

const control = new Socket({ fd: 3, readable: true, writable: true });
const ready = Buffer.from(
  JSON.stringify({ kind: "ready", port: 47119, credential: "x".repeat(43) }),
);
const frame = Buffer.alloc(4 + ready.length);
frame.writeUInt32BE(ready.length);
ready.copy(frame, 4);
control.write(frame);
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: "1.0",
    success: true,
    requestId: "service_stop",
    data: {
      kind: "service",
      state: "stopped",
      projectId: "project_synthetic",
      warnings: [],
    },
  })}\n`,
);
// This fixed test service owns no renderer, process or listener.
setTimeout(() => {
  control.end();
}, 50);
