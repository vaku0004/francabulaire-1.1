import { GoogleGenAI } from "@google/genai";

/**
 * Единственное место в проекте, где живёт GEMINI_API_KEY.
 * Ключ читается из серверного окружения и никогда не попадает в бандл.
 */

// Модели, которые приложению разрешено запрашивать. Без этого списка чужой
// запрос к прокси мог бы жечь квоту на произвольной дорогой модели.
const ALLOWED_MODELS = new Set([
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.7-flash",
  "gemma-4-26b-a4b-it",
]);

const DEFAULT_ORIGINS = [
  "https://francabulaire.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : DEFAULT_ORIGINS;

const MAX_BODY_BYTES = 128 * 1024;

// Ограничение частоты: лучшее, что можно сделать без общего хранилища.
// В serverless счётчик живёт в пределах одного инстанса, так что это заслон
// от скрипта в лоб, а не полноценная защита. См. README-заметку ниже.
const RATE_LIMIT_MAX = Number(process.env.GEMINI_RATE_LIMIT ?? 30);
const RATE_LIMIT_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // грубая защита от роста памяти
  return recent.length > RATE_LIMIT_MAX;
}

export interface ProxyRequest {
  body: unknown;
  origin?: string;
  /** Fallback for the rare browser that omits Origin on a same-origin POST. */
  referer?: string;
  ip?: string;
}

export interface ProxyResponse {
  status: number;
  body: Record<string, unknown>;
}

function fail(status: number, code: number, message: string): ProxyResponse {
  // Форма ответа повторяет то, что отдаёт Gemini, — клиент разбирает
  // error.code, чтобы решить, переключаться ли на следующую модель.
  return { status, body: { error: { code, message, status } } };
}

/** The request must prove it comes from one of our pages. */
function isTrustedCaller(origin?: string, referer?: string): boolean {
  if (origin) return allowedOrigins.includes(origin);
  // Browsers send Origin on cross-origin and (modern ones) on same-origin POST.
  // Referer is only a fallback; a bare script sends neither, which is the point.
  if (referer) {
    return allowedOrigins.some(o => referer === o || referer.startsWith(o + '/'));
  }
  return false;
}

export async function handleGeminiRequest({ body, origin, referer, ip }: ProxyRequest): Promise<ProxyResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY не задан в окружении сервера");
    return fail(500, 500, "Service is not configured.");
  }

  // Without this, a script that simply omits the Origin header could use our key freely:
  // the key never leaks, but the door to spending it was wide open.
  if (!isTrustedCaller(origin, referer)) {
    return fail(403, 403, "Origin not allowed.");
  }

  if (ip && rateLimited(ip)) {
    return fail(429, 429, "Too many requests.");
  }

  if (typeof body !== "object" || body === null) {
    return fail(400, 400, "Invalid request body.");
  }

  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return fail(413, 413, "Request too large.");
  }

  const { model, ...params } = body as Record<string, unknown>;

  if (typeof model !== "string" || !ALLOWED_MODELS.has(model)) {
    return fail(400, 400, "Unsupported model.");
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response: any = await ai.models.generateContent({ ...params, model } as any);

    // response.text — геттер на прототипе, при JSON.stringify он потерялся бы,
    // поэтому собираем ответ поштучно.
    return {
      status: 200,
      body: {
        candidates: response?.candidates ?? null,
        promptFeedback: response?.promptFeedback ?? null,
        usageMetadata: response?.usageMetadata ?? null,
        text: typeof response?.text === "string" ? response.text : undefined,
      },
    };
  } catch (err: any) {
    const parsed = (() => {
      try {
        return JSON.parse(err?.message)?.error;
      } catch {
        return null;
      }
    })();
    const code = Number(parsed?.code ?? err?.status ?? 500) || 500;
    // Наружу отдаём только код и нейтральный текст: сообщения Gemini могут
    // содержать детали запроса, которым в браузере делать нечего.
    console.error("Gemini proxy error:", code, err?.message);
    return fail(code >= 400 && code < 600 ? code : 500, code, parsed?.message ?? "Upstream error.");
  }
}
