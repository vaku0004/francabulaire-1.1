/**
 * Клиентская сторона обращения к Gemini. Ключа здесь нет и быть не должно:
 * запрос уходит на собственный эндпоинт /api/gemini, который держит ключ у себя.
 */

export class GeminiUnavailableError extends Error {
  constructor(message = "Le service IA est momentanément indisponible.") {
    super(message);
    this.name = "GeminiUnavailableError";
  }
}

export async function generateContent(params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  let res: Response;
  try {
    res = await fetch("/api/gemini", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
  } catch (err) {
    // Запрос отменили сами (другая модель ответила раньше) — это не сбой сети.
    if (signal?.aborted) throw err;
    // Сеть недоступна — до сервера не дошли вовсе.
    throw new GeminiUnavailableError();
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: res.status } }));
    // generateWithFallback разбирает err.message как JSON и смотрит error.code,
    // чтобы решить, пробовать ли следующую модель. Сохраняем этот контракт.
    throw new Error(JSON.stringify(body));
  }

  return res.json();
}

/**
 * Человеческое сообщение об ошибке. Отличает «попробуйте ещё раз» (действительно
 * поможет) от поломки конфигурации сервера (не поможет никогда — раньше в этом
 * случае пользователю всё равно предлагали повторить).
 */
export function describeGeminiError(err: unknown, fallback: string): string {
  if (err instanceof GeminiUnavailableError) return err.message;

  const code = (() => {
    try {
      return JSON.parse((err as Error)?.message)?.error?.code;
    } catch {
      return null;
    }
  })();

  switch (code) {
    case 429:
      return "Trop de requêtes. Patientez une minute avant de réessayer.";
    case 403:
      return "Le service IA a refusé la requête.";
    case 500:
    case 503:
      return "Le service IA est momentanément indisponible. Réessayez plus tard.";
    default:
      return fallback;
  }
}
