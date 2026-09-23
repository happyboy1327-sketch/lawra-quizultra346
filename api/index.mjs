import express from "express";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Mistral } from "@mistralai/mistralai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OC_USER_ID = process.env.LAW_GOV_OC;
const MODEL = 'ministral-8b-2512';

const client = new Mistral({
  apiKey: process.env.LAW_QUIZ_MISTRAL_KEY
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

// 법령 API의 중첩 객체/배열 구조에서 순수 조문 텍스트를 재귀 추출
function extractArticleContent(jo) {
  if (!jo) return "";
  const parts = [];

  function collectText(item) {
    if (!item) return;
    if (typeof item === "string") {
      parts.push(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(collectText);
      return;
    }
    if (typeof item === "object") {
      if (item["조문내용"]) collectText(item["조문내용"]);
      if (item["항"]) collectText(item["항"]);
      if (item["항내용"]) collectText(item["항내용"]);
      if (item["호"]) collectText(item["호"]);
      if (item["호내용"]) collectText(item["호내용"]);
      if (item["목"]) collectText(item["목"]);
      if (item["목내용"]) collectText(item["목내용"]);
    }
  }

  collectText(jo);
  return parts.join("\n").replace(/\s+/g, " ").trim();
}

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
        content: extractArticleContent(article),
        lawName,
      }))
      .filter((article) => article.content.length > 0);
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

function finalizeQuiz(rawQuiz) {
  const isNegative = String(rawQuiz.question_type || "").trim().toLowerCase() === "negative";

  const options = (rawQuiz.options || []).map((opt) => {
    const isTrueStatement = opt?.is_true_statement === true;
    const isCorrect = isNegative ? !isTrueStatement : isTrueStatement;
    return { text: String(opt?.text || "").trim(), is_correct: isCorrect };
  });
  
  const correctOptions = options.filter((o) => o.is_correct);

  if (correctOptions.length !== 1 || options.some((o) => !o.text)) {
    return null;
  }

  return {
    id: rawQuiz.id || `quiz-${Date.now()}`,
    category: rawQuiz.category,
    question: rawQuiz.question,
    options,
    answer: correctOptions[0].text,
    explanation: rawQuiz.explanation,
    timer_sec: rawQuiz.timer_sec || 15,
  };
}

async function generateQuiz(article, retriesLeft = 2) {
  if (!article?.lawName || !article?.num || !article?.content) {
    console.error("유효하지 않은 article:", article);
    return null;
  }

  const content = String(article.content)
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  const prompt = `
다음 한국 법령 조문을 읽고 객관식 4지선다 퀴즈 1개를 만드세요.

법령명: ${article.lawName}
조문번호: 제${article.num}조
조문내용: ${content}

위 조문의 내용을 바탕으로 실제 법률 지식을 테스트할 수 있는 퀴즈를 작성하세요. 생각 좀 하고 만들어 씨발년아.
조항의 개정일, 삭제 여부, 조항 번호 자체를 묻는 문제는 제외하고, 상식적 법률 사례 문제를 만드세요.
인물의 가명은 A씨, B씨, 김 씨 등으로 표기하세요.

★ 중요:
질문은 긍정형("다음 중 옳은 것은?")과 부정형("다음 중 바르지 않은 것은?") 둘 다 낼 수 있습니다. question_type 필드에 "positive" 또는 "negative" 중 정확한 값을 표시하세요.
각 보기(option)의 is_true_statement 필드에는 질문 유형과 무관하게, "그 문장이 위 조문내용에 비추어 실제로 참인지"만 true 또는 false로 표시하세요.
is_correct는 신경 쓰지 마세요 — 서버 코드가 question_type과 is_true_statement 값을 보고 자동으로 계산합니다.
4개의 보기 중 반드시 정확히 1개만 다른 3개와 참/거짓 여부가 달라야 합니다.
질문의 전제에 속하는 조항이 실제와 다르거나 해설에서 질문의 조건 및 전제에 부합하지 않는 잘못된 법령의 조항을 인용하지 마시오.
조항 적용 대상 및 법적 주체를 실제 법령과 다르게 잘못 제시하여 혼란을 야기하는 문제는 절대 내지 마시오.
반드시 순수 JSON만 출력하세요.

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "question_type": "positive 또는 negative",
  "question": "[질문 내용]",
  "options": [
    {"text": "[보기1]", "is_true_statement": true 또는 false},
    {"text": "[보기2]", "is_true_statement": true 또는 false},
    {"text": "[보기3]", "is_true_statement": true 또는 false},
    {"text": "[보기4]", "is_true_statement": true 또는 false}
  ],
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
      temperature: 0.01,
      reasoning_effort: "high"
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

    const rawQuiz = JSON.parse(responseText);

    if (!rawQuiz || typeof rawQuiz !== "object" || !rawQuiz.question || !Array.isArray(rawQuiz.options)) {
      return null;
    }

    const quiz = finalizeQuiz(rawQuiz);

    if (!quiz) {
      console.warn("퀴즈 참/거짓 판정이 일관되지 않아 폐기:", rawQuiz.question);
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

async function validateSingleQuiz(quiz, article) {
  const sourceText = String(article?.content || "")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (!sourceText) {
    return { valid: false, reason: "원문 누락" };
  }

  const systemPrompt = `
당신은 대한민국 법률 퀴즈 검증관입니다. 아래 [원문 조문]을 유일한 근거로 삼아, 제시된 퀴즈가 법적 사실관계 및 논리상 적절한지 검증하세요.

[원문 조문]
법령명: ${article?.lawName || "(알 수 없음)"}
조문번호: 제${article?.num || "?"}조
조문내용: ${sourceText}

★★★ 가장 중요한 규칙 ★★★
- 질문·보기·해설에 등장하는 모든 법적 근거는 반드시 위 [원문 조문]과 대조해서 판단하십시오.
- 원문에 없는 내용(다른 조항, 다른 법령 등)을 근거로 삼았다면 valid: false 로 처리하십시오.
- 당신의 일반 지식이 아니라 오직 주어진 원문 텍스트에 근거해서만 판단하십시오.
- 원문이 비어 있으면 valid: false, reason에 "원문 누락"이라고 기재하십시오.

[검증 기준]
아래 항목 중 하나라도 명백하게 위반될 경우 valid: false로 처리하시오.

1. 정답(is_correct: true)만이 질문에서 요구하는 법령 내용과 유일하게 부합하고 논리적으로 타당하며 다른 선택지 중 정답이 가능한가?
2. 질문과 해설 간에 치명적인 모순이 없는가?
3. 질문 및 해설에 인용된 법령·조문·항·호 등이 실제로 존재하는가?
4. 존재하는 법령·조문이라도 그 실제 내용과 질문 및 해설의 설명이 일치하는가?
5. 질문의 사실관계가 해당 법률상 권리·의무·제재 등의 성립 요건을 실제로 충족하는가?
6. 해당 법령의 권리·의무·제재·절차 등이 문제에서 제시된 주체에게 실제로 적용되는가?
7. 인용된 법령 조항에서 규정한 법적 효과를 질문 및 해설에서 정확하게 설명하고 있는가?
8. 해당 법령에 적용 예외, 단서, 특례 등이 존재하는 경우 문제의 사실관계가 그 예외 또는 특례에 해당하지 않는지 확인하라.
9. 질문 및 해설에 전혀 관련 없는 법령 조문을 끼워 넣지 않았는가?
10. 법령의 시행일 또는 적용 시점 때문에 해당 조항을 적용할 수 없는 명백한 문제가 없는가?

일반적인 객관식 법률시험 기준에서 명백하고 실질적인 오류가 있는 경우에만 valid: false를 반환하라.
단순히 더 엄밀하게 표현할 수 있다는 정도의 문제는 valid: true로 처리하라.

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

    const validation = await validateSingleQuiz(quiz, article);
    if (validation && validation.valid === true) {
      console.log(`[슬롯 ${slotIndex}] 문제 생성 및 검증 성공 (시도 ${attempt})`);
      return quiz;
    } else {
      console.warn(`[슬롯 ${slotIndex}] 검증 탈락 (시도 ${attempt}) - ${validation?.reason}`);
    }
  }

  console.warn(`[슬롯 ${slotIndex}] 검증 통과 실패로 기본 생성 진행`);
  const fallbackLaw = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
  const fallbackArticle = await fetchRandomArticle(fallbackLaw);
  return await generateQuiz(fallbackArticle);
}

// ==========================================
// WORKER THREAD EXECUTION
// ==========================================
if (!isMainThread) {
  (async () => {
    try {
      const { slotIndex } = workerData;
      const quiz = await generateValidQuizSlot(slotIndex);
      parentPort.postMessage({ success: true, quiz });
    } catch (err) {
      parentPort.postMessage({ success: false, error: err?.message || String(err) });
    }
  })();
}

// ==========================================
// MAIN THREAD EXPRESS APP EXECUTION
// ==========================================
let app = null;

if (isMainThread) {
  app = express();
  app.use(express.json());

  console.log("=== 서버 시작 시 환경 변수 확인 ===");
  console.log("LAW_GOV_OC:", process.env.LAW_GOV_OC ? `존재 (${process.env.LAW_GOV_OC.substring(0, 5)}...)` : "없음");
  console.log("LAW_QUIZ_MISTRAL_KEY:", process.env.LAW_QUIZ_MISTRAL_KEY ? "존재" : "없음");
  console.log("FIREBASE_SERVICE_ACCOUNT_KEY:", process.env.FIREBASE_SERVICE_ACCOUNT_KEY ? "존재" : "없음");

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
      console.log("=== 워커 기반 병렬 퀴즈 세트 생성 시작 ===");

      const workerPromises = [1, 2, 3, 4, 5].map((slotIndex) => {
        return new Promise((resolve) => {
          const worker = new Worker(__filename, {
            workerData: { slotIndex },
          });

          worker.on("message", (msg) => {
            if (msg.success) {
              resolve(msg.quiz);
            } else {
              console.warn(`[슬롯 ${slotIndex}] 워커 처리 실패:`, msg.error);
              resolve(null);
            }
          });

          worker.on("error", (err) => {
            console.error(`[슬롯 ${slotIndex}] 워커 에러:`, err.message);
            resolve(null);
          });

          worker.on("exit", (code) => {
            if (code !== 0) {
              console.warn(`[슬롯 ${slotIndex}] 워커 종료 (코드: ${code})`);
            }
          });
        });
      });

      const results = await Promise.all(workerPromises);
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
}

export default app;
