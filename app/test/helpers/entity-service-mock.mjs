import { createHash } from "node:crypto";
import { createServer } from "node:http";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

export async function startEntityServiceMock() {
  const blocks = new Map();
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer test-key") {
      send(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url, "http://mock.local");
    const match = url.pathname.match(/^\/v1\/blocks\/([^/]+)\/(.+)$/);
    if (!match) {
      send(response, 404, { error: "not found" });
      return;
    }
    const namespace = decodeURIComponent(match[1]);
    const key = match[2].split("/").map(decodeURIComponent).join("/");
    const mapKey = `${namespace}\n${key}`;

    if (request.method === "GET") {
      const block = blocks.get(mapKey);
      if (!block) {
        send(response, 404, { error: "block not found" });
        return;
      }
      send(response, 200, {
        metadata: block.metadata,
        data: block.data.toString("base64"),
      });
      return;
    }

    if (request.method === "PUT") {
      const input = await jsonBody(request);
      const existing = blocks.get(mapKey);
      const expected = Number(input.ifGenerationMatch ?? 0);
      const actual = existing?.metadata.generation ?? 0;
      if ((expected === -1 && existing) || (expected > 0 && expected !== actual)) {
        send(response, 409, { error: "generation mismatch" });
        return;
      }
      const data = Buffer.from(input.data || "", "base64");
      const generation = actual + 1;
      const metadata = {
        namespace,
        key,
        contentType: input.contentType || "application/octet-stream",
        ownerEntityId: String(input.ownerEntityId),
        sizeBytes: String(data.length),
        sha256: sha256(data),
        generation: String(generation),
        updatedAt: new Date().toISOString(),
      };
      blocks.set(mapKey, { data, metadata: { ...metadata, generation } });
      send(response, 200, metadata);
      return;
    }

    send(response, 405, { error: "method not allowed" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    blocks,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
