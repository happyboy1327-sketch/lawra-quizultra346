import express from "express";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Mistral } from "@mistralai/mistralai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

dotenv.config();

// ============================================================================
// 1. 설정 및 초기화 (Configuration & Init)
// ============================================================================
console.log("=== 서버 시작 시 환경 변수 확인 ===");
console.log("LAW_GOV_OC:", process.env.LAW_GOV_OC ? `존재 (${process.env.LAW_GOV_OC.substring(0, 5)}...)` : "없음");
console.log("LAW_QUIZ_MISTRAL_KEY:", process.env.LAW_QUIZ_MISTRAL_KEY ? "존재" : "없음");
console.log("FIREBASE_SERVICE_ACCOUNT_KEY:", process.env.FIREBASE_SERVICE_ACCOUNT_KEY ? "존재" : "없음");

const OC_USER_ID = process.env.LAW_GOV_OC;
const MODEL = 'ministral-14b-2512';
const LAW_API_URL = "https://www.law.go.kr/DRF/lawService.do";
const MISTRAL_MIN_INTERVAL_MS = 800;

const VALID_LAW_IDS = [
  { lawId: "001444", lawName: "대한민국헌법" },
  { lawId: "001706", lawName: "민법" },
  { lawId: "001692", lawName: "형법" },
  { lawId: "009318", lawName: "전자상거래 등에서의 소비자보호에 관한 법률" },
  { lawId: "001638", lawName: "도로교통법" },
  { lawId: "001248", lawName: "주택임대차보호법" },
  { lawId: "001206", lawName: "가사소송법" },
];

const client = new Mistral({ apiKey: process.env.LAW_QUIZ_MISTRAL_KEY });
const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;
let initializationError = null;

try {
  const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!rawKey) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY 환경 변수 없음");
  
  db = getFirestore(initializeApp({ credential: cert(JSON.parse(rawKey.trim())) }));
  console.log("Firebase Admin SDK 초기화 성공");
} catch (err) {
  console.error("Firebase Admin SDK 초기화 실패:", err.message);
  initializationError = `Firebase Admin 초기화 실패: ${err.message}`;
}

app.use((req, res, next) => {
  if (!db) {
    return res.status(500).json({ error: "DB 연결 실패", message: initializationError, serverError: true });
  }
  next();
});

// ============================================================================
// 2. 유틸리티 (Utilities)
// ============================================================================
const Utils = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

  shuffle: (array) => {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  isRateLimitError: (error) => {
    const status = error?.statusCode || error?.status || error?.response?.status;
    return status === 429 || /429|rate.?limit/i.test(error?.message || "");
  },

  normalizeText: function (value) {
    if (typeof value === "string") return value.trim();
    if (!value) return "";
    if (Array.isArray(value)) return value.map(this.normalizeText.bind(this)).filter(Boolean).join("\n");
    if (typeof value === "object") {
      const targetKey = ["text", "content", "explanation", "reason", "detail"].find(k => value[k] != null);
      return targetKey ? this.normalizeText(value[targetKey]) : JSON.stringify(value);
    }
    return String(value);
  },

  normalizeQuiz: function (quiz) {
    if (!quiz || typeof quiz !== "object") return null;

    const explanation = (() => {
      const rawExpl = quiz.explanation;
      if (rawExpl && typeof rawExpl === "object" && !Array.isArray(rawExpl)) {
        const boolVal = rawExpl.Boolean ?? rawExpl.boolean ?? false;
        return {
          string: this.normalizeText(rawExpl.string ?? rawExpl.text ?? ""),
          Boolean: typeof boolVal === "boolean" ? boolVal : String(boolVal).toLowerCase() === "true"
        };
      }
      return { string: this.normalizeText(rawExpl), Boolean: true };
    })();

    const rawOptions = (Array.isArray(quiz.options) ? quiz.options : []).map(opt => ({
      text: this.normalizeText(opt?.text ?? opt),
      is_correct: opt?.is_correct === true,
    }));

    const options = this.shuffle(rawOptions);

    const normalized = {
      ...quiz,
      id: this.normalizeText(quiz.id),
      category: this.normalizeText(quiz.category),
      explanation,
      question: this.normalizeText(quiz.question),
      answer: this.normalizeText(quiz.answer),
      timer_sec: Number(quiz.timer_sec) || 15,
      options,
    };

    normalized.explanation.string = normalized.explanation.string
      .replace(/^\s*\[[^\]]*(스니펫|원문 조문|수정된 해설)[^\]]*\]\s*/g, "").trim();

    return normalized;
  }
};

// ============================================================================
// 3. 법령 데이터 파싱 및 서비스 (Law Service)
// ============================================================================
const lawIdCache = new Map();
const lawArticlesCache = new Map();

async function getLawIdByName(lawName) {
  if (lawIdCache.has(lawName)) return lawIdCache.get(lawName);

  try {
    const response = await axios.get("https://www.law.go.kr/DRF/lawSearch.do", {
      params: { OC: OC_USER_ID, target: "law", type: "JSON", query: lawName },
    });

    const lawList = response.data?.LawSearch?.law;
    if (!lawList) return null;

    const items = Array.isArray(lawList) ? lawList : [lawList];
    const matched =
      items.find(
        (item) =>
          String(item?.["법령명한글"] || "").replace(/\s+/g, "") ===
          lawName.replace(/\s+/g, "")
      ) || items[0];

    const lawId = String(matched?.["법령일련번호"] || matched?.["법령ID"] || "");
    if (lawId) {
      lawIdCache.set(lawName, lawId);
      return lawId;
    }
  } catch (err) {
    console.error(`법령 검색 실패 (${lawName}):`, err.message);
  }
  return null;
}

async function getLawArticleMap(lawId) {
  if (lawArticlesCache.has(lawId)) return lawArticlesCache.get(lawId);

  try {
    const { data } = await axios.get(LAW_API_URL, {
      params: { OC: OC_USER_ID, type: "JSON", target: "eflaw", ID: lawId },
    });

    const joData = data?.["법령"]?.["조문"]?.["조문단위"] || data?.["법령"]?.["조문"];
    if (!joData) return new Map();

    const lawName = data?.["법령"]?.["기본정보"]?.["법령명_한글"] || "";
    const articleMap = new Map();

    (Array.isArray(joData) ? joData : [joData]).forEach((art) => {
      const parsed = LawParser.parseArticle(art, lawName);
      if (parsed.num && !parsed.isDeleted) articleMap.set(parsed.num, parsed);
    });

    lawArticlesCache.set(lawId, articleMap);
    return articleMap;
  } catch (err) {
    console.error(`법령 Map 로드 실패 (ID: ${lawId}):`, err.message);
    return new Map();
  }
}

function extractReferences(content) {
  if (!content) return { internal: [], external: [] };

  const external = [];
  const cleanContent = content.replace(
    /([가-힣]+법)\s*(제\s*\d+\s*조(?:의\s*\d+)?)/g,
    (match, lawName, articleNum) => {
      external.push({ lawName, articleNum: articleNum.replace(/\s+/g, "") });
      return "";
    }
  );

  const internalMatches = [...cleanContent.matchAll(/제\s*(\d+)\s*조(?:의\s*(\d+))?/g)];
  const internal = internalMatches.map((m) => `제${m[1]}조${m[2] ? `의${m[2]}` : ""}`);

  return { internal, external };
}

const LawParser = {
  getCanonicalArticleNum(article, joContent) {
    const rawNum = String(article?.["조문번호"] || "").trim();
    const rawGaji = String(article?.["조문가지번호"] || "").trim();
    
    if (rawNum && rawNum !== "0") {
      const gajiPart = rawGaji && rawGaji !== "0" && rawGaji !== "00" ? `의${rawGaji}` : "";
      return `제${rawNum}조${gajiPart}`;
    }

    const titleMatch = joContent.match(/^제\s*(\d+)\s*조(?:의\s*(\d+))?/);
    return titleMatch ? `제${titleMatch[1]}조${titleMatch[2] ? `의${titleMatch[2]}` : ""}` : "";
  },

  formatItemLine(no, content, indent = "") {
    const rawNo = String(no || "").trim();
    let rawContent = String(content || "").trim();
    if (!rawContent && !rawNo) return "";
    if (!rawContent) return `${indent}${rawNo}`;

    if (rawNo) {
      const coreNo = rawNo.replace(/(호|목|항)$/, "").trim();
      const escapedCore = coreNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`^(${escapedCore}|${rawNo}|\\d+\\.|[가-하]\\.)\\s*`);
      
      if (pattern.test(rawContent)) {
        return `${indent}${rawContent}`;
      } else {
        const prefix = rawNo.endsWith(".") || rawNo.startsWith("①") || rawNo.startsWith("제") ? rawNo : `${rawNo}.`;
        return `${indent}${prefix} ${rawContent}`;
      }
    }
    return `${indent}${rawContent}`;
  },

  parseSubItems(container, childKey, noKey, contentKey, nextChildKey, nextNoKey, nextContentKey, indent) {
    if (!container) return [];
    const items = Array.isArray(container[childKey])
      ? container[childKey]
      : container[childKey] ? [container[childKey]] : [];

    const lines = [];
    items.forEach(item => {
      const line = this.formatItemLine(item[noKey], item[contentKey], indent);
      if (line) lines.push(line);

      if (nextChildKey && item[nextChildKey]) {
        const subLines = this.parseSubItems(
          item,
          nextChildKey,
          nextNoKey,
          nextContentKey,
          null,
          null,
          null,
          indent + "  "
        );
        lines.push(...subLines);
      }
    });
    return lines;
  },

  parseArticle(article, lawName) {
    const joContent = String(article?.["조문내용"] || "").trim();
    const num = this.getCanonicalArticleNum(article, joContent);
    const title = String(article?.["조문제목"] || "").trim();
    
    const articleHeader = num ? `${num}${title ? (title.startsWith("(") ? title : `(${title})`) : ""}` : "";

    const hangs = article?.["항"];
    const hos = article?.["호"];

    const lines = [];
    const hangTexts = [];

    if (articleHeader) lines.push(articleHeader);

    if (hangs) {
      const hangList = Array.isArray(hangs) ? hangs : [hangs];
      hangList.forEach(h => {
        const hLines = [];
        const hText = String(h?.["항내용"] || "").trim();
        const hNo = String(h?.["항번호"] || "").trim();

        if (hText) {
          let cleanHText = hText;
          if (articleHeader && cleanHText.startsWith(articleHeader)) {
            cleanHText = cleanHText.replace(articleHeader, "").trim();
          }
          if (cleanHText) hLines.push(this.formatItemLine(hNo, cleanHText, ""));
        }

        if (h?.["호"]) {
          const hoLines = this.parseSubItems(h, "호", "호번호", "호내용", "목", "목번호", "목내용", "  ");
          hLines.push(...hoLines);
        }

        if (hLines.length > 0) {
          const joined = hLines.join("\n");
          hangTexts.push(joined);
          lines.push(joined);
        }
      });
    } else if (hos) {
      const hoLines = this.parseSubItems(article, "호", "호번호", "호내용", "목", "목번호", "목내용", "  ");
      if (hoLines.length > 0) {
        const joined = hoLines.join("\n");
        hangTexts.push(joined);
        lines.push(joined);
      }
    } else {
      if (joContent) {
        let contentOnly = joContent;
        if (articleHeader && contentOnly.startsWith(articleHeader)) {
          contentOnly = contentOnly.substring(articleHeader.length).trim();
        }
        if (contentOnly) {
          lines.push(contentOnly);
          hangTexts.push(contentOnly);
        }
      }
    }

    const fullContent = lines.join("\n").trim();
    return {
      num,
      content: fullContent,
      hang: hangTexts,
      lawName,
      isDeleted: joContent.includes("삭제") && fullContent.length < 20,
    };
  }
};

const LawService = {
  async fetchLawArticles(lawId) {
    if (!OC_USER_ID) return console.error("LAW_GOV_OC 환경 변수가 없음"), [];

    try {
      const articleMap = await getLawArticleMap(lawId);
      if (!articleMap.size) return [];

      const articlesWithRefs = await Promise.all(
        Array.from(articleMap.values()).map(async (parsed) => {
          const visited = new Set();
          const collected = new Map();

          const collectArticle = async (currentLawId, articleNum, currentDepth = 0, maxDepth = 2) => {
            if (!articleNum) return;

            const key = `${currentLawId}_${articleNum}`;
            if (visited.has(key)) return;
            visited.add(key);

            const currentMap = await getLawArticleMap(currentLawId);
            const article = currentMap?.get(articleNum);

            if (!article || article.isDeleted) return;
            collected.set(key, article);

            const { internal, external } = extractReferences(article.content);
            const totalRefCount = internal.length + external.length;

            const effectiveMaxDepth = totalRefCount === 1 ? currentDepth + 1 : maxDepth;
            if (currentDepth >= effectiveMaxDepth) return;

            for (const refNum of internal) {
              await collectArticle(currentLawId, refNum, currentDepth + 1, effectiveMaxDepth);
            }

            for (const ext of external) {
              const targetLawId = await getLawIdByName(ext.lawName);
              if (targetLawId && targetLawId !== currentLawId) {
                await collectArticle(targetLawId, ext.articleNum, currentDepth + 1, effectiveMaxDepth);
              }
            }
          };

          const selfKey = `${lawId}_${parsed.num}`;
          await collectArticle(lawId, parsed.num);

          const referencedContent = Array.from(collected.entries())
            .filter(([k]) => k !== selfKey)
            .map(([, refArt]) => `[${refArt.lawName} ${refArt.num}]\n${refArt.content}`)
            .join("\n\n");

          return { ...parsed, referencedContent };
        })
      );

      return articlesWithRefs;
    } catch (err) {
      console.error(`법령 API 오류 (ID: ${lawId}):`, err.message);
      return [];
    }
  },

  async fetchRandomArticle(law) {
    const articles = await this.fetchLawArticles(law.lawId);
    const validArticles = articles.filter((art) => art?.content && art.content.length >= 30);
    if (!validArticles.length) return console.warn("사용 가능한 조문 없음 (30자 이상 조문 없음):", law.lawName), null;
    return validArticles[Math.floor(Math.random() * validArticles.length)];
  }
};

// ============================================================================
// 4. 프롬프트 정의 (Prompts)
// ============================================================================
const PROMPTS = {
  generate: (article, content, refContent) => `
다음 한국 법령 조문 및 참조/인용 조문을 읽고 객관식 4지선다 퀴즈 1개를 만드세요. 영어는 절대로 단 한글자도 포함하면 안됩니다.

법령명: ${article.lawName}
조문번호: ${article.num}
[출제 조문 내용]
${content}

${refContent ? `[참조 및 인용 조문 내용]\n${refContent}\n` : ""}
위 조문의 내용과 참조 및 인용 조문 내용을 모두 읽고 실제 법률 지식을 테스트할 수 있는 퀴즈를 작성하세요.
□ 조항의 개정일, 삭제 여부, 조항 번호 자체를 묻는 문제는 제외하고, 상식적 법률 사례 문제를 만드세요.
□ 인물의 가명은 A씨, B씨, 김 씨 등으로 표기하고 해당 인물이 처한 상황과 맥락을 자세히 작성하시오.
□ 질문의 전제에 부합하는 정답을 확실하게 1개만 설정하고, 나머지는 명백한 오답으로 구성하세요.
□ ⚠️조문 원문에서 기간 및 정도, 금액이 나오는 부분과 법률 적용 판별 기준, 법률 행사 수단은 반드시 볼드(e.g. **2개월**, **높은 비율로**, **더 높은 금액", **1/3비율**, **조서**, **만 18세 미만** )표시하고 예의 주시해서 날짜 및 금액 계산하시어 해설에도 똑같이 원문에 있는 기간, 정도, 금액이 나오는 부분과 법률 적용 판별 기준, 법률 행사 수단을 대응작성하시오.
□ ⚠️해설 작성 시 '항(①, ② 등 원문자)'과 '호(1., 2. 등 숫자)'를 절대 혼동하지 말고 정확히 구분하여 기재하시오.
□ 질문에서 묻는 바, 정답 보기(options/answer), 해설(explanation)의 수치·단위·시점이 실제 법령 조문과 100% 일치해야 합니다.
□ 반드시 긍정문으로 묻는 질문만을 생성하고, 질문은 구체적으로 작성하시오. 간접 부정문(e.g. 위반되지 않는다고 볼 수 있는가?)도 금지합니다.
□ 정답이 1번일 시, quiz.options?.[0]?.text의 문자열(= "is_correct": true인 text의 문자열)을 따와야 합니다.
□ 반드시 순수 JSON만 출력하세요.

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "concept_summary": "[문제 푸는 목표 및 의도]",
  "explanation": {"string": "[인용된 법률 조문, 항, 호, 목과 일치하고 상통하는 상세 해설]", "Boolean": true},
  "question": "[질문 내용]",
  "options": [
    {"text": "[정답 내용]", "is_correct": true},
    {"text": "[오답 1]", "is_correct": false},
    {"text": "[오답 2]", "is_correct": false},
    {"text": "[오답 3]", "is_correct": false}
  ],
  "answer": "[정답 내용]",
  "timer_sec": 15
}`,

  blindSolve: (quiz, articleContext) => `
당신은 대한민국 법률 시험 수험생입니다. 아래의 [참조 법령]을 바탕으로 [질문]과 [보기]를 읽고 정답을 고르세요.

[참조 법령]
${articleContext}

[질문]
${quiz.question}

[보기]
1. ${quiz.options?.[0]?.text}
2. ${quiz.options?.[1]?.text}
3. ${quiz.options?.[2]?.text}
4. ${quiz.options?.[3]?.text}

규칙:
1. 4개 보기 중 가장 정확한 정답 1개만 고르시오.
2. 선택한 보기의 번호(1, 2, 3, 4 중 하나)를 숫자 정수로 chosen_number 필드에 적으시오.
3. 오직 순수 JSON만 출력하시오.

출력 형식:
{
  "chosen_number": 1,
  "reason": "[풀이 이유]"
}`,

  correction: (quiz, article, errorReason) => `
당신은 대한민국 법률 퀴즈 출제자입니다. 다음 퀴즈는 솔버 검증에서 논리적 오류로 실패했습니다. 
아래 [오류 사유]와 [원문 조문]을 바탕으로 퀴즈의 질문, 보기, 정답, 해설을 수정하십시오.
특히 해설에서 '항(①, ②)'과 '호(1., 2.)'를 절대 혼동하지 마십시오.

[원문 조문]
${article.content}
${article.referencedContent ? `\n[참조 조문]\n${article.referencedContent}` : ''}

[오류 사유]
${errorReason}

[기존 퀴즈 데이터]
${JSON.stringify(quiz, null, 2)}

위 오류를 수정한 후, 기존과 동일한 순수 JSON 형식으로만 출력하고 아래 완벽한 문제 기준에 맞게 정의하여 수정하십시오.
[완벽한 문제 기준]
1. 정답, 해설 내 수치(기간/금액/비율), 시점, 법적 주체, 의무/권고 구분이 원문과 정확히 일치해야 한다.
2. 질문의 조건과 전제가 해설, 정답의 논리와 들어맞고 상통해야 한다.
3. 인용한 조항 번호(조, 항, 호, 목)가 실존하며 내용과 상통해야 한다.
4. 법률 적용 조건, 법률 행사 수단, 법리 해석이나 판례/예시 적용에 오류 및 모순이 없어야 한다.
5. 정답(answer)과 해설(explanation)의 논리가 서로 일관되며 완전하게 일치해야 한다.
`
};

// ============================================================================
// 5. 퀴즈 서비스 및 3단계 검증 파이프라인 (Quiz AI Service)
// ============================================================================
const QuizService = {
  lastCallAt: 0,
  
  async throttle() {
    const wait = this.lastCallAt + MISTRAL_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await Utils.sleep(wait);
    this.lastCallAt = Date.now();
  },

  async requestMistral(prompt, reasoningEffort) {
    await this.throttle();
    const response = await client.chat.complete({
      model: MODEL,
      responseFormat: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      reasoning_effort: reasoningEffort,
    });
    
    let content = response?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return JSON.parse(content.replace(/^\s*```json\s*/i, "").replace(/^\s*```\s*/i, "").replace(/\s*```\s*$/i, "").trim());
  },

  async generateQuiz(article, retriesLeft = 2) {
    if (!article?.lawName || !article?.num || !article?.content || article.content.length < 30) return null;
    
    const content = String(article.content || "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
    const refContent = String(article.referencedContent || "").trim();
    const prompt = PROMPTS.generate(article, content, refContent);

    try {
      const rawQuiz = await this.requestMistral(prompt, "xhigh");
      return Utils.normalizeQuiz(rawQuiz);
    } catch (err) {
      if (Utils.isRateLimitError(err) && retriesLeft > 0) {
        await Utils.sleep(1500);
        return this.generateQuiz(article, retriesLeft - 1);
      }
      console.error("Mistral 퀴즈 생성 API 오류:", err.message);
      return null;
    }
  },

  // 1단계: 필수 필드 검증
  validateRequiredFields(quiz) {
    if (!quiz || typeof quiz !== "object") {
      return { valid: false, reason: "퀴즈 객체 데이터 없음" };
    }
    if (!quiz.question || typeof quiz.question !== "string" || !quiz.question.trim()) {
      return { valid: false, reason: "필수 필드 누락: question" };
    }
    if (!quiz.answer || typeof quiz.answer !== "string" || !quiz.answer.trim()) {
      return { valid: false, reason: "필수 필드 누락: answer" };
    }
    if (!quiz.explanation?.string || typeof quiz.explanation.string !== "string" || !quiz.explanation.string.trim()) {
      return { valid: false, reason: "필수 필드 누락: explanation.string" };
    }
    if (quiz.explanation.Boolean !== true) {
      return { valid: false, reason: "explanation.Boolean 필드가 true가 아님" };
    }
    if (!Array.isArray(quiz.options) || quiz.options.length !== 4) {
      return { valid: false, reason: `보기는 정확히 4개여야 함 (현재: ${quiz.options?.length ?? 0}개)` };
    }

    const correctOptions = quiz.options.filter(opt => opt.is_correct === true);
    if (correctOptions.length !== 1) {
      return { valid: false, reason: `정답 보기(is_correct=true)는 정확히 1개여야 함 (현재: ${correctOptions.length}개)` };
    }

    if (correctOptions[0].text.trim() !== quiz.answer.trim()) {
      return { valid: false, reason: "answer 필드 값과 정답 보기(is_correct=true)의 텍스트가 일치하지 않음" };
    }

    return { valid: true };
  },

  // 2단계: 블라인드 솔버 검증
  async validateBlindSolver(quiz, article) {
    try {
      const articleContext = String(article?.content || "").trim();
      const prompt = PROMPTS.blindSolve(quiz, articleContext);
      const res = await this.requestMistral(prompt, "high");

      const chosenNumber = Number(res?.chosen_number);
      if (!chosenNumber || chosenNumber < 1 || chosenNumber > 4) {
        return { valid: false, reason: "블라인드 솔버 응답 파싱 실패 (유효하지 않은 보기 번호)" };
      }

      const selectedOption = quiz.options[chosenNumber - 1];
      const isMatch = selectedOption?.is_correct === true;

      return {
        valid: isMatch,
        reason: isMatch
          ? `블라인드 솔버 풀이 성공 (${chosenNumber}번 정답 선택)`
          : `블라인드 솔버 답안 불일치 (솔버 선택: ${chosenNumber}번 "${selectedOption?.text}" vs 출제 정답: "${quiz.answer}")`,
      };
    } catch (err) {
      console.error("블라인드 솔버 실행 오류:", err.message);
      return { valid: false, reason: `블라인드 솔버 실행 실패: ${err.message}` };
    }
  },

  // 3단계: 자동 수정 (2단계 실패 시 호출)
  async fixQuiz(quiz, article, errorReason) {
    const prompt = PROMPTS.correction(quiz, article, errorReason);
    try {
      const rawQuiz = await this.requestMistral(prompt, "xhigh");
      return Utils.normalizeQuiz(rawQuiz);
    } catch (err) {
      console.error("자동 수정 API 오류:", err.message);
      return null;
    }
  },

  // 3단계 통합 검증 실행기
  async runValidationPipeline(quiz, article) {
    const step1 = this.validateRequiredFields(quiz);
    if (!step1.valid) {
      console.warn(`  └ [1단계 실패] ${step1.reason}`);
      return { valid: false, step: 1, reason: step1.reason, quiz };
    }
    console.log("  └ [1단계 통과] 필수 필드 검증 성공");

    const step2 = await this.validateBlindSolver(quiz, article);
    if (!step2.valid) {
      console.warn(`  └ [2단계 실패] ${step2.reason}`);
      console.log("  └ [3단계 진입] 2단계 실패에 따른 퀴즈 자동 수정 시도 중...");
      
      const correctedQuiz = await this.fixQuiz(quiz, article, step2.reason);
      if (!correctedQuiz) {
        return { valid: false, step: 3, reason: "자동 수정 생성 실패", quiz };
      }
      
      console.log("  └ [3단계 통과] 자동 수정 완료. 수정된 퀴즈로 재검증 실시...");
      
      // 재검증
      const reStep1 = this.validateRequiredFields(correctedQuiz);
      if (!reStep1.valid) return { valid: false, step: 1, reason: `재검증 필수 필드 실패: ${reStep1.reason}`, quiz: correctedQuiz };
      
      const reStep2 = await this.validateBlindSolver(correctedQuiz, article);
      if (!reStep2.valid) return { valid: false, step: 2, reason: `재검증 블라인드 솔버 실패: ${reStep2.reason}`, quiz: correctedQuiz };
      
      console.log("  └ [재검증 통과] 수정된 퀴즈 정답 논리 일치 확인");
      return { valid: true, reason: "자동 수정 후 검증 통과", quiz: correctedQuiz };
    }
    
    console.log("  └ [2단계 통과] 블라인드 솔버 일치 확인");
    return { valid: true, reason: "초기 검증 파이프라인 통과", quiz };
  },

  async generateValidQuizSlot(slotIndex, maxTries = 3) {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const law = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
      const article = await LawService.fetchRandomArticle(law);
      if (!article) continue;

      console.log(`\n[슬롯 ${slotIndex}] 퀴즈 생성 및 검증 시도 (${attempt}/${maxTries}) - 대상: ${law.lawName} ${article.num}`);

      const quiz = await this.generateQuiz(article);
      if (!quiz) {
        console.warn(`[슬롯 ${slotIndex}] 퀴즈 생성 실패`);
        continue;
      }

      const result = await this.runValidationPipeline(quiz, article);
      if (result.valid) {
        console.log(`[슬롯 ${slotIndex}] 최종 검증 성공 (시도 ${attempt})`);
        return result.quiz;
      }
    }
    console.warn(`[슬롯 ${slotIndex}] 모든 생성 및 검증 시도 실패`);
    return null;
  }
};

// ============================================================================
// 6. API 라우팅 (API Routes)
// ============================================================================
app.get("/api/lawquizzes/latest", async (req, res) => {
  try {
    const snapshot = await db.collection("law_quizzes").orderBy("createdAt", "desc").limit(1).get();
    if (snapshot.empty) return res.json([]);
    
    const data = snapshot.docs[0].data();
    const quizzes = Array.isArray(data.quizzes) ? data.quizzes : (data.quizzes ? Object.values(data.quizzes) : []);
    return res.json(quizzes);
  } catch (err) {
    console.error("최신 퀴즈 조회 오류:", err);
    return res.status(500).json({ error: err.message, serverError: true });
  }
});

app.post("/api/lawquizzes/new", async (req, res) => {
  try {
    console.log("=== 병렬 퀴즈 세트 생성 및 3단계 검증 시작 ===");
    const quizPromises = [1, 2, 3].map((index) => QuizService.generateValidQuizSlot(index));
    const results = await Promise.all(quizPromises);
    const newQuizzes = results.filter(Boolean);
    console.log(`=== 퀴즈 세트 생성 완료: ${newQuizzes.length}/3 ===`);

    if (newQuizzes.length === 0) {
      return res.status(400).json({ error: "퀴즈 생성 실패", message: "퀴즈 생성 및 3단계 검증 시도가 모두 실패했습니다.", serverError: true });
    }

    const quizSetId = String(Date.now());
    await db.collection("law_quizzes").doc(quizSetId).set({ createdAt: Date.now(), quizzes: newQuizzes });
    console.log("Firestore 저장 완료:", quizSetId);
    
    return res.json(newQuizzes);
  } catch (err) {
    console.error("퀴즈 세트 생성 중 오류 발생:", err);
    return res.status(500).json({ error: "퀴즈 생성 오류", message: err?.message || "알 수 없는 오류", serverError: true });
  }
});

app.get("/api/mistral-models", async (req, res) => {
  try {
    const response = await axios.get("[https://api.mistral.ai/v1/models](https://api.mistral.ai/v1/models)", {
      headers: { Authorization: `Bearer ${process.env.LAW_QUIZ_MISTRAL_KEY}` },
    });
    const models = Array.isArray(response.data?.data) ? response.data.data.map(model => model.id).filter(Boolean) : [];
    return res.json({ models });
  } catch (err) {
    console.error("Mistral 모델 목록 조회 오류:", err.message);
    return res.status(err?.response?.status || 500).json({ error: "Mistral 모델 목록 조회 실패", message: err?.response?.data?.message || err.message, serverError: true });
  }
});

app.use(express.static(path.join(__dirname, "..")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../index.html"));
});

export default app;
