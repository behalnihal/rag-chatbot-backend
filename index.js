import express from "express";
import dotenv from "dotenv";
import { QdrantClient } from "@qdrant/js-client-rest";
import { GoogleGenerativeAI } from "@google/generative-ai";
import https from "node:https";
import cors from "cors";
import redis from "redis";
import { v4 } from "uuid";
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const COLLECTION_NAME = "news_articles";

const qdrantUrl = process.env.QDRANT_URL || "http://localhost:6333";
const qdrantClient = new QdrantClient({
  url: qdrantUrl,
  apiKey: process.env.QDRANT_API_KEY,
});
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
const redisClient = redis.createClient({
  username: "default",
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// embed query
const getJinaEmbeddings = (text) => {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: "jina-embeddings-v2-base-en",
      input: [text],
    });
    const options = {
      hostname: "api.jina.ai",
      path: "/v1/embeddings",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": data.length,
        Authorization: `Bearer ${process.env.JINA_API_KEY}`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let chunks = "";
      res.on("data", (chunk) => {
        chunks += chunk;
      });
      res.on("end", () => {
        const ok =
          res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
        let parsed;
        try {
          parsed = JSON.parse(chunks);
        } catch (e) {
          if (!ok) {
            return reject(
              new Error(
                `Embeddings HTTP ${res.statusCode}. Headers: ${JSON.stringify(
                  res.headers
                )}. Body: ${chunks.slice(0, 500)}`
              )
            );
          }
          return reject(
            new Error(`Failed to parse embeddings response: ${e.message}`)
          );
        }
        if (!ok) {
          const message =
            parsed?.error?.message ||
            parsed?.error ||
            "Failed to get embeddings";
          return reject(new Error(`HTTP ${res.statusCode}: ${message}`));
        }
        const dataArr = parsed?.data;
        if (
          Array.isArray(dataArr) &&
          dataArr.length > 0 &&
          Array.isArray(dataArr[0]?.embedding)
        ) {
          return resolve(dataArr[0].embedding);
        }
        return reject(new Error("Embeddings response missing data"));
      });
    });

    req.on("error", (error) => {
      reject(error);
    });
    req.write(data);
    req.end();
  });
};

// routes
app.get("/", (req, res) => {
  res.status(200).json({ status: "ok" });
});
app.post("/api/chat", async (req, res) => {
  let { query, sessionId } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Query is required" });
  }

  if (!sessionId) {
    sessionId = v4();
    console.log(`New session created: ${sessionId}`);
  }

  const historyKey = `chat_history:${sessionId}`;

  try {
    console.log("Embedding query...", query);
    const queryEmbedding = await getJinaEmbeddings(query);
    const searchResponse = await qdrantClient.search(COLLECTION_NAME, {
      vector: queryEmbedding,
      limit: 3,
      with_payload: true,
    });

    const context = searchResponse
      .map((result) => result.payload.text)
      .join("\n\n---\n\n");
    console.log(
      "Retrieved context snippets:",
      searchResponse.map((r) => r.payload.text.substring(0, 50) + "...")
    );

    console.log("Generating final answer with Gemini...");
    const prompt = `You are helpful news assistant. Based on the following context, answer the user's question. Provide a concise answer and mention the source aritcle titles if possible.
      Context:
      ${context}
      Question:
      ${query}
      
      Answer:`;

    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const finalAnswer = response.text();

    // save convo to redis
    const userMessage = { sender: "user", text: query };
    const botMessage = { sender: "bot", text: finalAnswer };
    // using RPUSH to add to the end of list
    await redisClient.rPush(historyKey, JSON.stringify(userMessage));
    await redisClient.rPush(historyKey, JSON.stringify(botMessage));

    // return response with sessionId
    res.json({ answer: finalAnswer, sessionId: sessionId });
  } catch (error) {
    console.error("Error processing RAG pipeline:", error);
    res
      .status(500)
      .json({ error: "An error occurred while processing your request." });
  }
});

// get history
app.get("/api/history/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const historyKey = `chat_history:${sessionId}`;
  try {
    const history = await redisClient.lRange(historyKey, 0, -1);
    const messages = history.map((item) => JSON.parse(item));
    res.json({ messages });
  } catch (error) {
    console.error("Error fetching chat history:", error);
    res.status(500).json({ error: "Failed to fetch history." });
  }
});

// clear session
app.post("/api/clear/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const historyKey = `chat_history:${sessionId}`;
  try {
    await redisClient.del(historyKey);
    res.json({ message: "Session cleared successfully." });
  } catch (error) {
    console.error("Error clearing session:", error);
    res.status(500).json({ error: "Failed to clear session." });
  }
});

// start server
const startServer = async () => {
  await redisClient.connect();
  console.log("Connected to Redis");
  app.listen(port, () => {
    console.log(`Backend server is running on http://localhost:${port}`);
  });
};
startServer();
