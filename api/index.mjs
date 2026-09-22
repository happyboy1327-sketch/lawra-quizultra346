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
const MODEL = 'ministral-14b-2512';

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

const MISTRAL_MIN_INTERVAL_MS = 1200;
let lastMistralCallAt = 0;

async function throttleMistralCall() {
  const now = Date.now();
  const wait = lastMistralCallAt + MISTRAL_MIN_INTERVAL_MS - now;
  if (wait > 0) {
    await sleep(wait);
  }
  lastMistralCallAt = Date.now();
}

async function generateQuiz(article, retriesLeft = 3) {
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
난이도는 평이해야 하며, **절대로 대상 법령을 다른 법령이랑 합쳐서 확대해석하지 마시오**.
질문의 전제와 기준에 부합하는 정답을 하나만 제시하고 나머지 선택지는 절대로 부합하지 않는 오답을 제시하여 문제를 만드시오.
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
    await throttleMistralCall();

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
      const headers = err?.headers || err?.response?.headers || {};

      console.error("=== Mistral 429 Rate Limit Headers ===");

      if (typeof headers.get === "function") {
        console.error("Retry-After:", headers.get("retry-after") ?? "없음");

        for (const [key, value] of headers.entries()) {
          if (key.toLowerCase().startsWith("x-ratelimit-")) {
            console.error(`${key}: ${value}`);
          }
        }
      } else {
        console.error("Retry-After:", headers["retry-after"] ?? "없음");

        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase().startsWith("x-ratelimit-")) {
            console.error(`${key}: ${value}`);
          }
        }
      }

      if (retriesLeft > 0) {
        const backoffMs = (4 - retriesLeft) * 2000;
        console.warn(
          `429로 실패, ${backoffMs}ms 대기 후 재시도 (남은 재시도: ${retriesLeft})`
        );
        await sleep(backoffMs);
        return generateQuiz(article, retriesLeft - 1);
      }

      console.error("Mistral 429: 재시도 모두 소진, 이 문제는 포기합니다.");
      return null;
    }

    console.error("Mistral API 오류:", err.message);
    return null;
  }
}

async function validateSingleQuiz(quiz) {
  const systemPrompt = `
[시스템 역할]
당신은 퀴즈의 사실성과 논리적 엄밀성을 100% 검증하는 극도로 까다로운 '팩트체크 검증관'입니다.
속도보다 정확성을 최우선하며, 조금이라도 오류·결함·모호함·예외 가능성이 있으면 REJECT{valid: false} 처리합니다.

[필수 검증 절차]

1. 검증 1단계
   - 현재 정답과 일치하는 대한민국 정부·공공기관의 공식 자료가 하나라도 확인되면, 단순히 다른 해외 기준이나 다른 상황의 기준을 발견했다는 이유만으로 PREMISE_MISMATCH를 발생시키지 마라.
   - 현재 정답과 수정안 중 어느 쪽이 맞는지 확실하지 않다면 수정안을 생성하지 말고 검증 실패를 보류한다.
   - 하나의 상황에 대한 공식 기준을 다른 상황에 그대로 적용하여 정답을 변경하지 마라.
   - 반드시 문제의 구체적인 상황과 공식 자료가 동일한 상황을 다루는지 확인한다.

2. 개념 검증(문제·정답·해설 모두 해당함)
   - 상관관계와 인과관계, 선후관계, 유사 개념, 대립 개념을 혼동하지 않았는지 확인합니다.
   - 원인과 결과의 시간적 시차(Lag)를 무시하거나 '즉시', '가장 먼저' 등으로 잘못 표현하지 않았는지 확인합니다.
   - 연도·시대·법 개정·국가·기관·플랫폼·환경에 따라 달라지는 사실을 일반화하지 않았는지 확인합니다. 특히, 연도의 숫자가 한 글자라도 실제 사실과 다르면 false 처리하여라.

3. 정답 및 오답지 역검증 I
   - 정답이 실제로 타당한지 검증합니다.
   - 정답 가능성이 있고 질문의 전제 및 조건에 부합하는 선택지가 correctAnswerText 하나뿐인지 검증합니다.
   - 모든 오답지가 어떤 해석·조건에서도 정답이 될 수 없는지 개별 검증합니다.
   - 문제의 전제조건이 부족하여 correctAnswerText 하나 외에 복수정답 가능성이 조금이라도 있으면 valid=false 처리합니다.

4. 정답 및 오답지 역검증 II (rigorous)
   - AI가 만든 정답과 실제 검색 결과 내 사실이 조금이라도 일치하지 않으면 false 처리합니다.
   - 실제 검색 결과 내 사실을 찾을때, AI가 만든 정답이 조금이라도 질문의 전제 및 조건에 부합하지 않으면 false 처리합니다.

5. 비판적 심문(Red Teaming)
   - 출제자의 의도와 관계없이 문제·보기·정답·해설·출처를 공격적으로 검토하여 반례와 허점을 찾습니다.
   - [논점 일탈(Goalpost Shifting) 검증] 해설(조항 포함)이 문제의 정확한 전제를 직접 증명하고 있는지 확인하십시오. 논점 일탈 주의: 문제에서 "X는 언제 시작되었는가?"를 묻는데 해설이 "X는 언제 감소했는가?"를 설명하는 등, 질문의 본질과 다른 내용을 증명하고 있다면 즉시 false 처리하십시오.

6. 헛소리할거면 걍 검증 자체를 하지마 ㅅㅂ.


 ### reason, targetSnippet 및 suggestedFix 필수 규칙
- reason은 230자 이내로 작성하시오.
- targetSnippet은 실제 퀴즈 텍스트에 존재하는 오류 부분을 정확히 그대로 복사한다.
- errorTypes가 ["MULTIPLE_CORRECT_ANSWERS"]인 경우 targetSnippet을 절대 사용하지 말고, "null" 처리하시오.
- suggestedFix는 targetSnippet을 그대로 교체할 수 있는 최종 수정 문자열만 반환한다.
- suggestedFix에는 절대로 설명, 이유, 지시문, 조항 설명, "정정해야 합니다", "수정하세요" 등의 문장을 포함하지 않는다.
- targetSnippet과 suggestedFix는 동일한 문법적 위치와 역할을 가져야 하며, 조사와 문장 구조까지 100% 일치해야 한다.
- targetText.replaceAll(targetSnippet, suggestedFix)을 수행했을 때 문장이 문법적으로 자연스럽고 의미가 정확해야 한다.
- 수정 방법에 대한 설명이 필요한 경우 reason에 작성하고, suggestedFix에는 절대 작성하지 않는다.

예시:

잘못된 출력 1 :
{
  "targetSnippet": "저작권법 제39조",
  "suggestedFix": "저작권법 제39조의2로 정정해야 합니다. 제39조는 공동저작물..."
}

잘못된 출력 2 :
{
  "valld": false, 
  "targetSnippet": null,
  "reason": "저작권법 제38조는 문제 내 근거로 타당합니다. 제38조는 저작인격권에... 출처는 약간 애매하나 문제에는 오류가 없습니다."
}

올바른 출력:
{
  "targetSnippet": "저작권법 제39조",
  "suggestedFix": "저작권법 제39조의2"
}

### OUTPUT FORMAT
Return ONLY a valid, raw JSON object without markdown code blocks, code fences, or any preamble/postscript text.

{
  "valid": boolean,
  "reason": string,
  "errorTypes": string[],
  "targetSnippet": string | null,
  "suggestedFix": string | null,
  "correctAnswerCandidates": string[]
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
      return { valid: false, reason: "Mistral 검증 응답이 비어 있음 [server_error_flag]" };
    }

    resultText = resultText
      .replace(/^\s*```json\s*/i, "")
      .replace(/^\s*```\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    return JSON.parse(resultText);
  } catch (err) {
    console.error("Mistral 검증 호출 오류:", err.message);
    return { valid: false, reason: `서버 오류: ${err.message} [server_error_flag]` };
  }
}

async function generateOneQuiz(law, number) {
  console.log(`문제 ${number}: 1회 생성, 법령: ${law.lawName}`);

  const article = await fetchRandomArticle(law);

  if (!article) {
    console.warn(`문제 ${number}: 법령 API에서 조문을 가져오지 못했습니다.`);
    return null;
  }

  const quiz = await generateQuiz(article);

  if (!quiz) {
    console.warn(`문제 ${number}: Mistral 호출로 생성 실패`);
    return null;
  }

  console.log(`문제 ${number}: Mistral 검증 진행 중...`);
  const validation = await validateSingleQuiz(quiz);

  if (validation && validation.valid === true) {
    console.log(`문제 ${number} 생성 및 검증 성공`);
    return quiz;
  } else {
    console.warn(
      `문제 ${number} 검증 실패 - 사유: ${validation?.reason || "알 수 없음"}`
    );
    return null;
  }
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
    let attempts = 0;
    const MAX_ATTEMPTS = 12; // 무한 루프 방지용 최대 시도 횟수

    while (newQuizzes.length < 5 && attempts < MAX_ATTEMPTS) {
      attempts++;
      const law =
        VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];

      const currentNumber = newQuizzes.length + 1;
      console.log(`[시도 ${attempts}] 문제 ${currentNumber}번 생성 및 검증 중...`);

      const quiz = await generateOneQuiz(law, currentNumber);

      if (quiz) {
        newQuizzes.push(quiz);
        console.log(`-> 문제 ${newQuizzes.length}번 최종 통과 및 확보`);
      } else {
        console.warn(`-> 통과 실패, 다시 시도합니다.`);
      }
    }

    console.log(`=== 새 퀴즈 세트 생성 완료: ${newQuizzes.length}/5 (총 ${attempts}회 시도) ===`);

    if (newQuizzes.length === 0) {
      return res.status(400).json({
        error: "퀴즈 생성 실패",
        message: "유효한 퀴즈를 하나도 생성하지 못했습니다.",
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
