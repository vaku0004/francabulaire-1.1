import { handleGeminiRequest } from "./_gemini.js";

/** Обёртка для serverless-функции Vercel. */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: { code: 405, message: "Method not allowed." } });
    return;
  }

  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();

  const { status, body } = await handleGeminiRequest({
    body: req.body,
    origin: req.headers.origin as string | undefined,
    ip: ip || req.socket?.remoteAddress,
  });

  res.status(status).json(body);
}
