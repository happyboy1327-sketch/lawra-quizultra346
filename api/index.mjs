import express from "express";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Mistral } from "@mistralai/mistralai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

dotenv.config();

console.log("=== 서버 시작 시 환경 변수 확인 ===");
console.log("LAW_GOV_OC:", process.env.LAW_GOV_OC ? `존재 (${process.env.LAW_GOV_OC.substring(0, 5)}...)` : "없음");
console.log("LAW_QUIZ_MISTRAL_KEY:", process.env.LAW_QUIZ_MISTRAL_KEY ? "존재" : "없음");
console.log("FIREBASE_SERVICE_ACCOUNT_KEY:", process.env.FIREBASE_SERVICE_ACCOUNT_KEY ? "존재" : "없음");

const OC_USER_ID = process.env.LAW_GOV_OC;
const MODEL = 'mistral-small-latest';

const client = new Mistral({
  apiKey: process.env.LAW_QUIZ_MISTRAL_KEY });

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;
let initializationError = null;

try {
  const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!rawKey) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY 환경 변수 없음");
  }

  const serviceAccountKey = JSON.parse(rawKey.trim());

  const firebaseApp = initializeApp({
    credential: cert(serviceAccountKey),
  });

  db = getFirestore(firebaseApp);
  console.log("Firebase Admin SDK 초기화 성공");
} catch (err) {
  console.error("Firebase Admin SDK 초기화 실패:", err.message);
  initializationError = `Firebase Admin 초기화 실패: ${err.message}`;
}

app.use((req, res, next) => {
  if (!db) {
    return res.status(500).json({
      error: "DB 연결 실패",
      message: initializationError,
    });
  }
  next();
});

const VALID_LAW_IDS = [
  { lawId: "001444", lawName: "대한민국헌법" },
  { lawId: "001706", lawName: "민법" },
  { lawId: "001692", lawName: "형법" },
  { lawId: "009318", lawName: "전자상거래 등에서의 소비자보호에 관한 법률" },
  { lawId: "001638", lawName: "도로교통법" },
  { lawId: "001248", lawName: "주택임대차보호법" },
  { lawId: "001206", lawName: "가사소송법" },
];

const LAW_API_URL = "https://www.law.go.kr/DRF/lawService.do";

async function fetchLawArticles(lawId) {
  if (!OC_USER_ID) {
    console.error("LAW_GOV_OC 환경 변수가 없음");
    return [];
  }

  try {
    const response = await axios.get(LAW_API_URL, {
      params: {
        OC: OC_USER_ID,
        type: "JSON",
        target: "eflaw",
        ID: lawId,
      },
    });

    const lawData = response.data;
    const joData = lawData?.["법령"]?.["조문"]?.["조문단위"];

    if (!joData) {
      console.error("법령 조문 데이터 없음");
      return [];
    }

    const articles = Array.isArray(joData) ? joData : [joData];
    const lawName = lawData?.["법령"]?.["기본정보"]?.["법령명_한글"] || "";

    return articles
      .filter(Boolean)
      .map((article) => ({
        num: article["조문번호"],
        content: article["조문내용"],
        lawName,
      }));
  } catch (err) {
    console.error(`법령 API 오류 (ID: ${lawId}):`, err.message);
    return [];
  }
}

async function fetchRandomArticle(law) {
  const articles = await fetchLawArticles(law.lawId);

  if (articles.length === 0) {
    console.warn("사용 가능한 조문 없음:", law.lawName);
    return null;
  }

  return articles[Math.floor(Math.random() * articles.length)];
}

function isRateLimitError(error) {
  const message = String(error?.message || "");

  return (
    error?.statusCode === 429 ||
    error?.status === 429 ||
    error?.response?.status === 429 ||
    /status\s*429|status.?code.?429|rate.?limit|rate limited/i.test(message)
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateQuiz(article) {
  if (!article?.lawName || !article?.num) {
    console.error("유효하지 않은 article:", article);
    return null;
  }

  const content = String(article.content || "")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  const prompt = `
다음 한국 법령 조문을 읽고 객관식 4지선다 퀴즈 1개를 만드세요.

법령명: ${article.lawName}
조문번호: 제${article.num}조
조문내용: ${content}

위 조문의 내용을 바탕으로 실제 법률 지식을 테스트할 수 있는 퀴즈를 작성하세요.
조항의 내용을 묻는 문제나 조항의 개정일, 삭제 여부를 묻는 문제는 절대로 출제하지 마세요.
사례를 제시하여 현행 법령을 기준으로 판단하는 문제나 생활 법률 상식 문제를 출제하세요.
인물의 가명은 A씨, B씨, 김 씨, 박 씨 등으로 표기하세요.
난이도는 평이해야 하며, 문제의 질문은 80자 이내로 제한합니다.
정답 1개와 그럴듯한 오답 3개를 만드세요.

반드시 순수 JSON만 출력하세요.
마크다운 코드블록이나 설명 없이 JSON만 출력하세요.

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "question": "[actual question text]",
  "options": [
    {"text": "[correct answer]", "is_correct": true},
    {"text": "[wrong answer 1]", "is_correct": false},
    {"text": "[wrong answer 2]", "is_correct": false},
    {"text": "[wrong answer 3]", "is_correct": false}
  ],
  "answer": "[same as correct answer text]",
  "explanation": "[detailed explanation]",
  "timer_sec": 15
}
`;

  try {
    const response = await client.chat.complete({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
    });

    let responseText = response?.choices?.[0]?.message?.content;

    if (!responseText || typeof responseText !== "string") {
      console.error("Mistral 응답이 비어 있음");
      return null;
    }

    responseText = responseText
      .replace(/^\s*```json\s*/i, "")
      .replace(/^\s*```\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    const quiz = JSON.parse(responseText);

    if (!quiz || typeof quiz !== "object") {
      return null;
    }

    console.log("퀴즈 생성 완료:", quiz.id);
    return quiz;
  } catch (err) {
    if (isRateLimitError(err)) {
      const headers = err?.response?.headers || err?.headers || {};

      console.error("=== Mistral 429 Rate Limit Headers ===");
      console.error("Retry-After:", headers["retry-after"] ?? "없음");

      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase().startsWith("x-ratelimit-")) {
          console.error(`${key}: ${value}`);
        }
      }

      const rateLimitError = new Error("Mistral rate limit (429)");
      rateLimitError.isRateLimit = true;
      throw rateLimitError;
    }

    console.error("Mistral API 오류:", err.message);
    return null;
  }
}

async function generateOneQuiz(law, number) {
  console.log(`문제 ${number}: 1회 생성, 법령: ${law.lawName}`);

  // 문제 1개당 법령 API는 정확히 1회 호출
  const article = await fetchRandomArticle(law);

  if (!article) {
    console.warn(`문제 ${number}: 법령 API에서 조문을 가져오지 못했습니다.`);
    return null;
  }

  // 문제 1개당 Mistral API는 정확히 1회 호출
  const quiz = await generateQuiz(article);

  if (quiz) {
    console.log(`문제 ${number} 생성 완료`);
    return quiz;
  }

  console.warn(`문제 ${number}: Mistral 1회 호출로 생성 실패`);
  return null;
}

app.get("/api/lawquizzes/latest", async (req, res) => {
  try {
    const snapshot = await db
      .collection("law_quizzes")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.json([]);
    }

    const data = snapshot.docs[0].data();

    const quizzes = Array.isArray(data.quizzes)
      ? data.quizzes
      : data.quizzes
        ? Object.values(data.quizzes)
        : [];

    return res.json(quizzes);
  } catch (err) {
    console.error("최신 퀴즈 조회 오류:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/lawquizzes/new", async (req, res) => {
  try {
    console.log("=== 새 퀴즈 세트 생성 시작 ===");

    const newQuizzes = [];

    for (let i = 0; i < 5; i++) {
      const law =
        VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];

      const quiz = await generateOneQuiz(law, i + 1);

      if (quiz) {
        newQuizzes.push(quiz);
        console.log(`문제 ${i + 1} 생성 완료`);
      } else {
        console.warn(`문제 ${i + 1} 생성 실패`);
      }
    }

    console.log(`=== 새 퀴즈 세트 생성 완료: ${newQuizzes.length}/5 ===`);

    if (newQuizzes.length === 0) {
      return res.status(400).json({
        error: "퀴즈 생성 실패",
        message: "모든 퀴즈 생성 시도가 실패했습니다.",
      });
    }

    const quizSetId = String(Date.now());

    await db.collection("law_quizzes").doc(quizSetId).set({
      createdAt: Date.now(),
      quizzes: newQuizzes,
    });

    console.log("Firestore 저장 완료:", quizSetId);

    return res.json(newQuizzes);
  } catch (err) {
    console.error("새 퀴즈 세트 생성 중 오류 발생:", err);

    return res.status(500).json({
      error: "퀴즈 생성 오류",
      message: err?.message || "알 수 없는 오류",
    });
  }
});

app.get("/api/mistral-models", async (req, res) => {
  try {
    const response = await axios.get("https://api.mistral.ai/v1/models", {
      headers: {
        Authorization: `Bearer ${process.env.LAW_QUIZ_MISTRAL_KEY}`,
      },
    });

    const models = Array.isArray(response.data?.data)
      ? response.data.data.map((model) => model.id).filter(Boolean)
      : [];

    return res.json({ models });
  } catch (err) {
    console.error("Mistral 모델 목록 조회 오류:", err.message);

    return res.status(err?.response?.status || 500).json({
      error: "Mistral 모델 목록 조회 실패",
      message: err?.response?.data?.message || err.message,
    });
  }
});

app.use(express.static(path.join(__dirname, "..")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../index.html"));
});

export default app;
