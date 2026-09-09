import type { IncomingMessage, ServerResponse } from "http";
import { handleGeminiRequest } from "./_gemini.js";

/**
 * Адаптер для «голого» node-сервера: express в продакшене и dev-сервер Vite.
 * Возвращает true, если запрос обработан.
 */
export async function serveGemini(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith("/api/gemini")) return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: 405, message: "Method not allowed." } }));
    return true;
  }

  const body = req.body !== undefined ? req.body : await readJsonBody(req);

  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();

  const result = await handleGeminiRequest({
    body,
    origin: req.headers.origin,
    ip: ip || req.socket?.remoteAddress || undefined,
  });

  res.statusCode = result.status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(result.body));
  return true;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) return null; // отсекаем заведомо мусорные тела
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
