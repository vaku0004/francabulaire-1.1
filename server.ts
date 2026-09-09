import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import "dotenv/config";
import { serveGemini } from "./api/_node-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "256kb" }));

  // Прокси к Gemini — до статики, иначе SPA-fallback перехватит запрос.
  // app.all, а не app.post: иначе GET проваливается в SPA-фолбэк ниже
  // и вместо 405 отдаёт index.html.
  app.all("/api/gemini", async (req, res) => {
    await serveGemini(req as any, res as any);
  });

  // Static files and SPA fallback
  const distPath = path.join(__dirname, "dist");
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    // Development fallback (redundant if using vite dev server, but good for structure)
    app.get("*", (req, res) => {
      res.status(404).send("Dist folder not found. Run npm build.");
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
