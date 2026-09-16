import type { IncomingMessage, ServerResponse } from "node:http";
import { createJummahService } from "../src/application.js";
import type { PublicJummah } from "../src/domain/jummah.js";

const service = createJummahService();

function setPublicApiHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  setPublicApiHeaders(response);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET, OPTIONS");
    response.statusCode = 405;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const current = await service.getCurrent();
    const jummah: PublicJummah | null = current
      ? {
          id: current.id,
          firstStartTime: current.firstStartTime,
          firstEndTime: current.firstEndTime,
          firstLocation: current.firstLocation,
          secondStartTime: current.secondStartTime,
          secondEndTime: current.secondEndTime,
          secondLocation: current.secondLocation,
          updatedAt: current.updatedAt,
        }
      : null;

    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    response.end(JSON.stringify({ jummah }));
  } catch (error) {
    console.error("Failed to retrieve Jummah information", error);
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({ error: "Unable to retrieve Jummah information" }),
    );
  }
}
