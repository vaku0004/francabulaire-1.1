/**
 * Страховка от повторения утечки: после сборки проверяем, что серверный
 * ключ не просочился в dist/. Запускается как часть `npm run build`,
 * в том числе на Vercel, поэтому сломанная сборка не доедет до прода.
 */
import fs from "fs";
import path from "path";

const DIST = "dist";
const fail = (msg) => {
  console.error(`\n❌ Проверка секретов не пройдена:\n   ${msg}\n`);
  process.exit(1);
};

if (!fs.existsSync(DIST)) fail(`каталог ${DIST}/ не найден — сборка не создана?`);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const files = walk(DIST);
const contents = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

// На Vercel ключ приходит из окружения, локально лежит в .env — читаем и его,
// иначе локальная сборка молча пропускала бы самую точную из проверок.
function keyFromDotenv() {
  try {
    const lines = fs.readFileSync(".env", "utf8").split("\n");
    const line = lines.find((l) => l.startsWith("GEMINI_API_KEY="));
    if (!line) return null;
    return line.slice("GEMINI_API_KEY=".length).trim().replace(/^"|"$/g, "") || null;
  } catch {
    return null;
  }
}

// 1. Значение серверного ключа не должно встречаться нигде в бандле.
const serverKey = process.env.GEMINI_API_KEY || keyFromDotenv();
if (serverKey) {
  const hit = [...contents].find(([, c]) => c.includes(serverKey));
  if (hit) fail(`GEMINI_API_KEY попал в ${hit[0]}. Проверьте define в vite.config.ts и префиксы VITE_.`);
} else {
  console.log("  ℹ GEMINI_API_KEY не найден ни в окружении, ни в .env — сверка по значению пропущена.");
}

// 2. Само имя переменной в бандле означает, что ключ пытались протащить на клиент.
const named = [...contents].find(([, c]) => c.includes("GEMINI_API_KEY"));
if (named) fail(`упоминание GEMINI_API_KEY в ${named[0]}. Ключ Gemini не должен существовать на клиенте.`);

// 3. Любой ключ Google, кроме заведомо публичного firebase-ключа, — повод остановиться.
// Google выдаёт ключи Gemini в двух видах: классическом AIza… и новом AQ.… —
// проверка только по первому пропустила бы настоящий ключ.
const KEY_PATTERNS = [/AIza[0-9A-Za-z_-]{30,}/g, /\bAQ\.[0-9A-Za-z_-]{40,60}\b/g];

const firebaseKeys = new Set(
  [
    process.env.VITE_FIREBASE_API_KEY,
    (fs.readFileSync("src/lib/firebase.ts", "utf8").match(/AIza[0-9A-Za-z_-]{30,}/) || [])[0],
  ].filter(Boolean),
);

const found = new Set();
for (const [, c] of contents) {
  for (const re of KEY_PATTERNS) for (const k of c.match(re) || []) found.add(k);
}

const unexpected = [...found].filter((k) => !firebaseKeys.has(k));
if (unexpected.length) {
  fail(`в бандле неизвестный ключ Google: ${unexpected.map((k) => k.slice(0, 10) + "…").join(", ")}. ` +
       `Если он публичный по замыслу — добавьте его в исключения этого скрипта осознанно.`);
}

console.log(`  ✅ секретов в ${DIST}/ не найдено (публичных firebase-ключей: ${found.size})`);
