import { describe, it, expect, beforeAll, afterAll } from "node:test";
import assert from "node:assert";
import { httpFetch } from "./http";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { AddressInfo } from "node:net";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (url === "/ok") {
      res.writeHead(200, { "Content-Type": "text/plain", "X-Custom": "test-value" });
      res.end("hello world");
    } else if (url === "/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "ok" }));
    } else if (url === "/echo" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(body);
      });
    } else if (url === "/not-found") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    } else if (url === "/slow") {
      // Delay longer than our test timeout
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("slow response");
      }, 5000);
    } else {
      res.writeHead(400);
      res.end("bad request");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("httpFetch", () => {
  it("should fetch a successful text response", async () => {
    const response = await httpFetch(`${baseUrl}/ok`);

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.body).toBe("hello world");
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.headers["x-custom"]).toBe("test-value");
  });

  it("should fetch a JSON response as text", async () => {
    const response = await httpFetch(`${baseUrl}/json`);

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(JSON.parse(response.body)).toEqual({ message: "ok" });
    expect(response.headers["content-type"]).toBe("application/json");
  });

  it("should handle POST requests with a body", async () => {
    const response = await httpFetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "request body content",
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("request body content");
  });

  it("should handle non-2xx responses without throwing", async () => {
    const response = await httpFetch(`${baseUrl}/not-found`);

    expect(response.status).toBe(404);
    expect(response.ok).toBe(false);
    expect(response.body).toBe("not found");
  });

  it("should throw on timeout", async () => {
    await expect(
      httpFetch(`${baseUrl}/slow`, { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out after 100ms/);
  });

  it("should throw on network error (invalid URL)", async () => {
    await expect(
      httpFetch("http://127.0.0.1:1/nonexistent"),
    ).rejects.toThrow();
  });

  it("should use GET method by default", async () => {
    const response = await httpFetch(`${baseUrl}/ok`);
    expect(response.status).toBe(200);
  });
});
