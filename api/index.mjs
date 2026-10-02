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
    const lawName =
      lawData?.["법령"]?.["기본정보"]?.["법령명_한글"] || "";

    // ============================================================
    // 내부 함수 1: 조문 하나를 기존 형식으로 변환
    // ============================================================
    function parseArticle(article) {
      const num = String(article?.["조문번호"] || "").trim();
      const joContent = String(article?.["조문내용"] || "").trim();

      const lines = [];
      if (joContent) lines.push(joContent);

      const hangTexts = [];
      const hangRaw = article?.["항"];
      const hoRaw = article?.["호"];

      // 1. 항 -> 호 -> 목
      if (hangRaw) {
        const hangList = Array.isArray(hangRaw)
          ? hangRaw
          : [hangRaw];

        hangList.forEach((h) => {
          const hLines = [];

          const hangContent =
            String(h?.["항내용"] || "").trim();

          if (hangContent) {
            hLines.push(hangContent);
          }

          const innerHo = h?.["호"];

          if (innerHo) {
            const hoList = Array.isArray(innerHo)
              ? innerHo
              : [innerHo];

            hoList.forEach((ho) => {
              const hoContent =
                String(ho?.["호내용"] || "").trim();

              if (hoContent) {
                hLines.push(`  ${hoContent}`);
              }

              const innerMok = ho?.["목"];

              if (innerMok) {
                const mokList = Array.isArray(innerMok)
                  ? innerMok
                  : [innerMok];

                mokList.forEach((m) => {
                  const mokContent =
                    String(m?.["목내용"] || "").trim();

                  if (mokContent) {
                    hLines.push(`    ${mokContent}`);
                  }
                });
              }
            });
          }

          if (hLines.length > 0) {
            const combinedHang = hLines.join("\n");

            hangTexts.push(combinedHang);
            lines.push(combinedHang);
          }
        });
      }

      // 2. 항 없이 조문 바로 밑에 호가 있는 경우
      else if (hoRaw) {
        const hoList = Array.isArray(hoRaw)
          ? hoRaw
          : [hoRaw];

        hoList.forEach((ho) => {
          const hoContent =
            String(ho?.["호내용"] || "").trim();

          if (hoContent) {
            hangTexts.push(hoContent);
            lines.push(`  ${hoContent}`);
          }
        });
      }

      const fullContent = lines.join("\n").trim();

      return {
        num,
        content: fullContent,
        hang: hangTexts,
        lawName,
      };
    }

    // ============================================================
    // 내부 함수 2: 조문 내용에서 "제○조" 형태 추출
    // ============================================================
    function extractReferencedArticleNumbers(content) {
      if (!content) return [];

      const found = new Set();

      /*
       * 찾는 형태:
       *
       * 제10조
       * 제10조의2
       * 제10조의 2
       * 제10조제2항
       * 제10조의2제3항
       *
       * 최종적으로는 "제10조", "제10조의2"만 반환
       */
      const regex = /제\s*(\d+)\s*조(?:의\s*(\d+))?/g;

      let match;

      while ((match = regex.exec(content)) !== null) {
        const articleNumber = match[2]
          ? `제${match[1]}조의${match[2]}`
          : `제${match[1]}조`;

        found.add(articleNumber);
      }

      return [...found];
    }

    // ============================================================
    // 내부 함수 3: 전체 조문을 "조문번호 -> 조문" 형태로 저장
    // ============================================================
    const articleMap = new Map();

    articles.forEach((article) => {
      const parsed = parseArticle(article);

      if (parsed.num) {
        articleMap.set(parsed.num, parsed);
      }
    });

    // ============================================================
    // 내부 함수 4: 특정 조문이 참조하는 조문을 재귀적으로 찾기
    // ============================================================
    const collected = new Map();
    const visited = new Set();

    function collectArticle(article) {
      if (!article?.num) return;

      // 이미 처리한 조문이면 다시 들어가지 않음
      if (visited.has(article.num)) return;

      visited.add(article.num);

      // 기존 코드와 동일하게 37자 미만은 결과에서 제외
      if (article.content.length >= 37) {
        collected.set(article.num, article);
      }

      // 현재 조문의 전체 내용에서 다른 조문 찾기
      const referencedNumbers =
        extractReferencedArticleNumbers(article.content);

      referencedNumbers.forEach((referencedNum) => {
        const referencedArticle =
          articleMap.get(referencedNum);

        // 현재 법령에 실제 존재하는 조문일 때만 추가
        if (
          referencedArticle &&
          !visited.has(referencedNum)
        ) {
          collectArticle(referencedArticle);
          console.log('재귀 OK');
        }
      });
    }

    // ============================================================
    // 내부 함수 5: 최초 조문들을 기존 방식대로 처리
    // ============================================================
    articles.forEach((article) => {
      const parsed = parseArticle(article);

      if (
        parsed.num &&
        parsed.content.length >= 37
      ) {
        collectArticle(parsed);
      }
    });

    return [...collected.values()];
  } catch (err) {
    console.error(
      `법령 API 오류 (ID: ${lawId}):`,
      err.message
    );

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

function normalizeText(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (value == null) {
    return "";
  }

  if (Array.isArray(value)) {
    return value
      .map(normalizeText)
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value === "object") {
    // 모델이 { text: "..." }, { content: "..." } 형태로 반환하는 경우
    const preferredKeys = ["text", "content", "explanation", "reason", "detail"];

    for (const key of preferredKeys) {
      if (value[key] != null) {
        const text = normalizeText(value[key]);
        if (text) return text;
      }
    }

    // 위 필드가 없으면 객체 전체를 안전한 JSON 문자열로 변환
    return JSON.stringify(value);
  }

  return String(value);
}

function normalizeQuiz(quiz) {
  if (!quiz || typeof quiz !== "object") {
    return null;
  }

  // explanation 정규화
  let normalizedExplanation;

  if (
    quiz.explanation &&
    typeof quiz.explanation === "object" &&
    !Array.isArray(quiz.explanation)
  ) {
    const explanationText = normalizeText(
      quiz.explanation.string ??
      quiz.explanation.text ??
      ""
    );

    // Boolean / boolean / 문자열 "true", "false" 모두 처리
    const rawBoolean =
      quiz.explanation.Boolean ??
      quiz.explanation.boolean ??
      false;

    let explanationBoolean;

    if (typeof rawBoolean === "boolean") {
      explanationBoolean = rawBoolean;
    } else {
      explanationBoolean =
        String(rawBoolean).toLowerCase() === "true";
    }

    normalizedExplanation = {
      string: explanationText,
      Boolean: explanationBoolean,
    };
  } else {
    // 기존 문자열 explanation도 호환
    normalizedExplanation = {
      string: normalizeText(quiz.explanation),
      Boolean: true,
    };
  }

  const normalized = {
    ...quiz,

    id: normalizeText(quiz.id),

    category: normalizeText(quiz.category),

    explanation: normalizedExplanation,

    question: normalizeText(quiz.question),

    answer: normalizeText(quiz.answer),

    timer_sec: Number(quiz.timer_sec) || 15,

    options: Array.isArray(quiz.options)
      ? quiz.options.map((option) => ({
          text: normalizeText(option?.text ?? option),
          is_correct: option?.is_correct === true,
        }))
      : [],
  };

  // explanation은 객체이므로 string을 검사
  if (
    !normalized.question ||
    !normalized.explanation.string ||
    normalized.explanation.Boolean !== true ||
    normalized.options.length !== 4
  ) {
    return null;
  }

  const correctCount = normalized.options.filter(
    (option) => option.is_correct
  ).length;

  if (correctCount !== 1) {
    return null;
  }

  return normalized;
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
조문 및 항 내용: ${content}

위 조문의 내용을 모두 읽고 실제 법률 지식을 테스트할 수 있는 퀴즈를 작성하세요. 하나라도 만족하지 않을시 재생성하시오.
□ 조항의 개정일, 삭제 여부, 조항 번호 자체를 묻는 문제는 제외하고, 상식적 법률 사례 문제를 만드세요.
□ 인물의 가명은 A씨, B씨, 김 씨 등으로 표기하고 해당 인물이 처한 상황과 맥락을 자세히 작성하시오.
□ 질문의 전제에 부합하는 정답을 확실하게 1개만 설정하고, 나머지는 명백한 오답으로 구성하세요.
□ ⚠️조문 원문에서 기간이 나오는 부분은 반드시 볼드(e.g. **2개월**)표시하고 예의 주시해서 날짜 계산하시어 해설에도 똑같이 원문에 있는 기간을 대응작성하시오.
□ 해설 내 텍스트가 정확한 설명이 아닐 경우, 혹은 아래의 경우에는 explanation 내 Boolean 필드에 false 처리하시오.
- ⚠️인용 조항이 조금이라도 애매하거나 법적으로 잘못 해석될 여지가 있을 경우
- ⚠️없는 조문을 지어내는 경우
- ⚠️인용할 법률의 조항 번호가 잘못 써있는 경우 
- ⚠️기간을 실제 법령과 다르게 잘못 서술한 경우
□ 조항 번호를 하나도 모르겠으면 비워놓고 번호를 제외한 내용만 써놓으시오.
□ 질문에서 묻는 바(예: 소멸시효 기간, 공소 시효 기간, 행정 절차 기간 등), 정답 보기(options/answer), 해설(explanation)의 수치·단위·시점이 실제 법령 조문과 100% 일치해야 합니다.
□ 질문이 특정 법적 개념(예: '소멸시효는 얼마인가?', '효력이 발생하는 날은 언제인가?')을 물을 경우, 정답 보기는 그 질문에 직접적으로 대응하는 단위와 수치(예: '3년')여야 하며, 질문과 무관한 시점이나 엉뚱한 조건(예: '1개월이 지난 시점')을 정답으로 설정하지 마시오.
□ 질문에 맞는 정답이 해설 첫 두 문장 중 하나라도 일치하지 않으면 다시 출제하시오.
□ 범죄자가 한 행위 자체와 행위 자체를 실제로 당사자에게 행하였을때, 사용했을때를 반드시 심리적 해석과 실제 법령에 맞게 구분하여 작성하시오.
□ 질문의 질문 의도, 정답 내용, 해설의 법리 해석 간에 단 하나라도 삼박자가 맞지 않거나 논리적 핀트가 어긋나면 문제 작성을 중단하고 재생성하시오.
□ 반드시 긍정문으로 묻는 질문만을 생성하고, 질문은 구체적으로 작성하고, 수식 관계를 명확히 쉼표로 구분하시오.
□ 반드시 순수 JSON만 출력하세요.
□ 객체, 배열, 중첩 JSON을 explanation 값으로 사용하지 마세요.
□ 해설이 여러 문장인 경우 하나의 문자열 안에 줄바꿈(\n)을 사용하세요.
□ 해설엔 질문의 논리에 부합하고 정확한 법령조문 및 항 내용을 인용하시오.

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "concept_summary": "[문제 푸는 목표, 법률이 적용되는 주체, 법률을 어떻게 해석하는지의 의도]",
  "explanation": {"string": "[인용된 법률 조문과 일치하고 상통하는 상세 해설]", "Boolean": "true"},
  "question": "[질문 내용]",
  "options": [
    {"text": "[정답 내용]", "is_correct": true},
    {"text": "[오답 1]", "is_correct": false},
    {"text": "[오답 2]", "is_correct": false},
    {"text": "[오답 3]", "is_correct": false}
  ],
  "answer": "[정답 내용과 동일 텍스트]",
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
      reasoning_effort: "high",
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
const normalizedQuiz = normalizeQuiz(quiz);

if (!normalizedQuiz) {
  console.error("유효하지 않은 퀴즈 응답:", quiz);
  return null;
}

return normalizedQuiz;
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
    .replace(/[ \t]+/g, " ")
    .trim();

  console.log("[검증 및 자동수정 시작]", {
    lawName: article?.lawName,
    articleNumber: article?.num,
    sourceLength: sourceText.length,
    sourcePreview: sourceText.slice(0, 320),
  });

  if (!sourceText) {
    return {
      valid: false,
      reason: "원문 누락",
      repairedQuiz: null,
    };
  }

  const validationPayload = {
    source: {
      lawName: String(article?.lawName || ""),
      articleNumber: String(article?.num || ""),
      content: sourceText,
    },
    quiz,
  };

  const userPrompt = `
당신은 사실성과 법리성을 우선으로 하는 대한민국 법률 퀴즈 검증 및 교정관입니다. 
제시된 퀴즈가 아래 [원문 조문]과 일치하는지 검증하고, 원문과 불합치하거나 질문-정답-해설 내 전체 텍스트 간 모순이 있을 경우 원문 조문 스니펫을 완벽히 반영하여 자동 수정(Snippet Auto-Fix)하십시오.

[검증 및 교정 기준]
1. 질문·보기·해설의 법적 수치, 시점, 주체, 법리 해석이 [원문 조문]과 100% 일치해야 합니다.
2. 상관관계와 인과관계, 선후관계가 올바른지, 유사 법률, 대립되는 법률을 혼동하지 않았는지 확인하시오. 
3. 질문에서 의도한 기간 조건이 정답에서 제대로 계산되었는지 실제 법령과 비교하며 검사하시오. 시효 기간을 실제 법령과 다르게 잘못 서술한 경우 false 처리하시오.
4. 권리, 의무, 원칙, 예외, 가능 등의 사항을 착각하여 실제 법령에 맞지 않게 잘못 해석하지 않았는지 확인하시오.
 → 해설 내 인용 조항이 조금이라도 애매하거나 법적으로 잘못 해석되어 있을 경우, false 처리하시오.
5. 실제로 없는 법령 조문 및 조항, 벌칙을 지어내진 않았는지, 실제 적용될 법령의 조항 번호를 착각 및 환각했는지 확인하시오.
6. 전혀 관련없는 법령 조문을 질문 및 해설에 끼어넣지 않았는지 확인하시오.
7. 해당 법령의 권리·의무·제재·절차 등이 문제에서 제시된 주체에게 실제로 적용되는지 확인하시오.
 → 소비자, 사업자, 근로자, 사용자, 행정기관, 법원, 공무원 등 각 주체의 법적 지위와 적용 대상을 정확히 구분하시오. 해설 내 법적 지위와 적용 대상이 실제 조항의 그것과 일치하지 않으면 절대 안됩니다.
8. 질문이 묻는 본질(예: 소멸시효 기간), 정답 보기의 내용, 해설 내 법령 인용 및 수치/시점이 서로 완벽히 부합하는지 확인하시오.
9. 질문에 맞는 정답과 해설의 첫 두 문장 간 내용이 불합치하거나 핀트가 어긋나면 valid: false 처리하십시오.
10. valid: false인 경우, 오직 [원문 조문] 텍스트 스니펫에 근거하여 질문, 4지선다 보기(정답 1개 필수), 정답(answer), 해설(explanation)을 즉시 교정한 repairedQuiz 객체를 반드시 생성하십시오.
11. valid: true인 경우 repairedQuiz는 null로 설정하십시오.

### OUTPUT FORMAT (JSON ONLY)
{
  "valid": boolean,
  "reason": "검증 실패 원인 또는 수정 내역",
  "repairedQuiz": {
    "id": "${quiz.id}",
    "category": "${quiz.category}",
    "explanation": {"string": "[원문 조문 스니펫과 완벽히 부합하도록 수정한 해설]", "Boolean": "true"},
    "question": "[질문 의도와 원문 조문에 맞게 수정한 질문]",
    "options": [
      {"text": "[정답 내용]", "is_correct": true},
      {"text": "[오답 1]", "is_correct": false},
      {"text": "[오답 2]", "is_correct": false},
      {"text": "[오답 3]", "is_correct": false}
    ],
    "answer": "[정답 내용과 동일 텍스트]",
    "timer_sec": 15
  } | null
}

[원문 조문 및 퀴즈 데이터] : ${JSON.stringify(validationPayload, null, 2)}
`;

  try {
    await throttleMistralCall();

    const response = await client.chat.complete({
      model: MODEL,
      responseFormat: { type: "json_object" },
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0,
      reasoning_effort: "high",
    });

    let resultText = response?.choices?.[0]?.message?.content;

    if (!resultText || typeof resultText !== "string") {
      return { valid: false, reason: "검증 응답 비어 있음", repairedQuiz: null };
    }

    resultText = resultText
      .replace(/^\s*```json\s*/i, "")
      .replace(/^\s*```\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(resultText);

    if (typeof parsed.valid !== "boolean") {
      return {
        valid: false,
        reason: "검증 결과 형식 오류",
        repairedQuiz: null,
      };
    }

    const repaired = parsed.repairedQuiz ? normalizeQuiz(parsed.repairedQuiz) : null;

    return {
      valid: parsed.valid,
      reason: String(parsed.reason || ""),
      repairedQuiz: repaired,
    };
  } catch (err) {
    console.error("Mistral 검증/수정 호출 오류:", err.message);
    return {
      valid: true,
      reason: "검증 API 호출 실패로 임시 통과",
      repairedQuiz: null,
    };
  }
}

async function generateValidQuizSlot(slotIndex, maxTries = 3) {
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const law = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
    const article = await fetchRandomArticle(law);

    if (!article) continue;

    const quiz = await generateQuiz(article);
    if (!quiz) continue;

    const validation = await validateSingleQuiz(quiz, article);

    if (validation?.valid === true) {
  console.log(
    `[슬롯 ${slotIndex}] 1차 문제 생성 및 검증 성공 (시도 ${attempt})`
  );

  // 강제 추가 검증
  const revalidation = await validateSingleQuiz(quiz, article);

  if (revalidation?.valid === true) {
    console.log(
      `[슬롯 ${slotIndex}] 2차 강제 검증까지 성공 (시도 ${attempt})`
    );
    return quiz;
  }

  console.log(
    `[슬롯 ${slotIndex}] 2차 강제 검증 실패 → 재시도`
  );
}


// 2. 검증 탈락 시 스니펫 기반 자동 수정본(repairedQuiz) 채택 및 디버깅 데이터 바인딩
    if (validation?.repairedQuiz) {
      console.log(`\n================ [슬롯 ${slotIndex} 자동 수정 내역 디버깅] ================`);
      console.log(`- 사유: ${validation?.reason}`);
      console.log(`- 수정 전 질문: ${quiz.question}`);
      console.log(`- 수정 후 질문: ${validation.repairedQuiz.question}`);
      console.log(`- 수정 전 해설은 ${quiz.explanation?.string}`);
      console.log(`- 수정 후 해설은 ${validation.repairedQuiz.explanation?.string}`);
      console.log(`- 수정 전 정답: ${quiz.answer}`);
      console.log(`- 수정 후 정답: ${validation.repairedQuiz.answer}`);
      console.log(`========================================================================\n`);

      return {
        ...validation.repairedQuiz,
        isRepaired: true,
        repairReason: validation.reason,
        debugInfo: {
          originalQuestion: quiz.question,
          originalAnswer: quiz.answer,
          originalExplanation: quiz.explanation,
        },
      };
    }

    console.warn(
      `[슬롯 ${slotIndex}] 검증 및 자동수정 실패 (시도 ${attempt}) - ${validation?.reason}`
    );
  }

  console.warn(`[슬롯 ${slotIndex}] 모든 생성 및 검증/자동수정 시도 실패`);
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
