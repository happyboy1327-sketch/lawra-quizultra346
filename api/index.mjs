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
const MODEL = 'ministral-8b-2512';

const client = new Mistral({
  apiKey: process.env.LAW_QUIZ_MISTRAL_KEY
});

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

const MISTRAL_MIN_INTERVAL_MS = 800;
let lastMistralCallAt = 0;

async function throttleMistralCall() {
  const now = Date.now();
  const wait = lastMistralCallAt + MISTRAL_MIN_INTERVAL_MS - now;
  if (wait > 0) {
    await sleep(wait);
  }
  lastMistralCallAt = Date.now();
}

async function generateQuiz(article, retriesLeft = 2) {
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
조항의 개정일, 삭제 여부, 조항 번호 자체를 묻는 문제는 제외하고, 상식적 법률 사례 문제를 만드세요.
인물의 가명은 A씨, B씨, 김 씨 등으로 표기하세요.
질문의 전제에 부합하는 정답을 확실하게 1개만 설정하고, 나머지는 명백한 오답으로 구성하세요.
반드시 긍정문으로 묻는 질문만을 생성하시오.
해설 비울거면 걍 서버 폭발시켜버리고 503 내라.
반드시 순수 JSON만 출력하세요.

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "question": "[질문 내용]",
  "options": [
    {"text": "[정답 내용]", "is_correct": true},
    {"text": "[오답 1]", "is_correct": false},
    {"text": "[오답 2]", "is_correct": false},
    {"text": "[오답 3]", "is_correct": false}
  ],
  "answer": "[정답 내용과 동일 텍스트]",
  "explanation": "[상세 해설]",
  "timer_sec": 15
}
`;

  try {
    await throttleMistralCall();

    const response = await client.chat.complete({
      model: MODEL,
      responseFormat: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    let responseText = response?.choices?.[0]?.message?.content;

    if (!responseText || typeof responseText !== "string") {
      return null;
    }

    responseText = responseText
      .replace(/^\s*```json\s*/i, "")
      .replace(/^\s*```\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    const quiz = JSON.parse(responseText);

    if (!quiz || typeof quiz !== "object" || !quiz.question || !Array.isArray(quiz.options)) {
      return null;
    }

    return quiz;
  } catch (err) {
    if (isRateLimitError(err) && retriesLeft > 0) {
      await sleep(1500);
      return generateQuiz(article, retriesLeft - 1);
    }
    console.error("Mistral API 오류:", err.message);
    return null;
  }
}

async function validateSingleQuiz(quiz) {
  const systemPrompt = `
당신은 대한민국 법률 퀴즈 검증관입니다. 제시된 퀴즈가 법적 사실관계 및 논리상 적절한지 검증하세요.

[검증 기준]
1. 정답(is_correct: true)이 질문에서 요구하는 법령 내용과 부합하고 논리적으로 타당한가?
2. 정답이 2개 이상이거나 정답이 없는 등의 오류가 없는가?
3. 질문과 해설 간에 치명적인 모순이 없는가?
4. 실제로 없는 법령 조문 및 조항을 지어내진 않았는가?
5. 전혀 관련없는 법령 조문을 질문 및 해설에 끼어넣었는가?

대증적인 억지 트집이나 지엽적인 논점 확대는 피하고, 일반적인 객관식 시험 기준에 비추어 명백한 오류가 있을 때만 valid: false를 반환하세요.

### OUTPUT FORMAT (JSON ONLY)
{
  "valid": boolean,
  "reason": string
}
`;

  try {
    await throttleMistralCall();

    const response = await client.chat.complete({
      model: MODEL,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(quiz) }
      ],
      temperature: 0,
    });

    let resultText = response?.choices?.[0]?.message?.content;

    if (!resultText) {
      return { valid: false, reason: "검증 응답 비어 있음" };
    }

    resultText = resultText
      .replace(/^\s*```json\s*/i, "")
      .replace(/^\s*```\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    return JSON.parse(resultText);
  } catch (err) {
    console.error("Mistral 검증 호출 오류:", err.message);
    // 검증 API 실패 시 퀴즈 생성 실패로 처리하지 않고 완화 처리
    return { valid: true, reason: "검증 통과 (기본값)" };
  }
}

async function generateValidQuizSlot(slotIndex, maxTries = 2) {
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const law = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
    const article = await fetchRandomArticle(law);
    if (!article) continue;

    const quiz = await generateQuiz(article);
    if (!quiz) continue;

    const validation = await validateSingleQuiz(quiz);
    if (validation && validation.valid === true) {
      console.log(`[슬롯 ${slotIndex}] 문제 생성 및 검증 성공 (시도 ${attempt})`);
      return quiz;
    } else {
      console.warn(`[슬롯 ${slotIndex}] 검증 탈락 (시도 ${attempt}) - ${validation?.reason}`);
    }
  }

  // maxTries 내 실패 시 검증 단계를 생략한 퀴즈 생성 시도 (Fallback)
  console.warn(`[슬롯 ${slotIndex}] 검증 통과 실패로 기본 생성 진행`);
  const fallbackLaw = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
  const fallbackArticle = await fetchRandomArticle(fallbackLaw);
  return await generateQuiz(fallbackArticle);
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
    console.log("=== 병렬 퀴즈 세트 생성 시작 ===");

    // 5개의 퀴즈를 동시에 병렬로 생성
    const quizPromises = [1, 2, 3, 4, 5].map((index) => generateValidQuizSlot(index));
    const results = await Promise.all(quizPromises);

    const newQuizzes = results.filter(Boolean);

    console.log(`=== 퀴즈 세트 생성 완료: ${newQuizzes.length}/5 ===`);

    if (newQuizzes.length === 0) {
      return res.status(400).json({
        error: "퀴즈 생성 실패",
        message: "퀴즈 생성 시도가 모두 실패했습니다.",
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
    console.error("퀴즈 세트 생성 중 오류 발생:", err);

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
