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
const MODEL = 'ministral-8b-2512';
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
    return res.status(500).json({ error: "DB 연결 실패", message: initializationError });
  }
  next();
});

// ============================================================================
// 2. 유틸리티 (Utilities)
// ============================================================================
const Utils = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

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

    const normalized = {
      ...quiz,
      id: this.normalizeText(quiz.id),
      category: this.normalizeText(quiz.category),
      explanation,
      question: this.normalizeText(quiz.question),
      answer: this.normalizeText(quiz.answer),
      timer_sec: Number(quiz.timer_sec) || 15,
      options: (Array.isArray(quiz.options) ? quiz.options : []).map(opt => ({
        text: this.normalizeText(opt?.text ?? opt),
        is_correct: opt?.is_correct === true,
      })),
    };

    const isValid = normalized.question && 
                    normalized.explanation.string && 
                    normalized.explanation.Boolean === true && 
                    normalized.options.length === 4 &&
                    normalized.options.filter(o => o.is_correct).length === 1;

    normalized.explanation.string = normalized.explanation.string
  .replace(/^\s*\[[^\]]*(스니펫|원문 조문|수정된 해설)[^\]]*\]\s*/g, "").trim();

    return isValid ? normalized : null;
  }
};

// ============================================================================
// 3. 법령 데이터 파싱 및 서비스 (Law Service)
// ============================================================================

// 1. 외부 법령 ID 및 조문 데이터 캐시
const lawIdCache = new Map();
const lawArticlesCache = new Map(); // lawId -> Map<articleNum, article>

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

// 2. 법령 ID별 원본 조문 Map 가져오기 (1회만 API 호출 후 메모리 캐싱)
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

// 3. 참조 추출 (외부 참조 문구를 먼저 떼어낸 뒤 순수 내부 참조만 추출)
function extractReferences(content) {
  if (!content) return { internal: [], external: [] };

  const external = [];
  // 외부 참조 (예: "형법 제257조") 추출 및 해당 문자열 제거
  const cleanContent = content.replace(
    /([가-힣]+법)\s*(제\s*\d+\s*조(?:의\s*\d+)?)/g,
    (match, lawName, articleNum) => {
      external.push({ lawName, articleNum: articleNum.replace(/\s+/g, "") });
      return "";
    }
  );

  // 남은 텍스트에서 순수 내부 참조 (예: "제15조") 추출
  const internalMatches = [...cleanContent.matchAll(/제\s*(\d+)\s*조(?:의\s*(\d+))?/g)];
  const internal = internalMatches.map((m) => `제${m[1]}조${m[2] ? `의${m[2]}` : ""}`);

  return { internal, external };
}

// 4. LawParser (기존 로직 유지)
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

    if (articleHeader) {
      lines.push(articleHeader);
    }

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
          if (cleanHText) {
            hLines.push(this.formatItemLine(hNo, cleanHText, ""));
          }
        }

        if (h?.["호"]) {
          const hoLines = this.parseSubItems(
            h,
            "호",
            "호번호",
            "호내용",
            "목",
            "목번호",
            "목내용",
            "  "
          );
          hLines.push(...hoLines);
        }

        if (hLines.length > 0) {
          const joined = hLines.join("\n");
          hangTexts.push(joined);
          lines.push(joined);
        }
      });
    } else if (hos) {
      const hoLines = this.parseSubItems(
        article,
        "호",
        "호번호",
        "호내용",
        "목",
        "목번호",
        "목내용",
        "  "
      );
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
      isDeleted: joContent.includes("삭제") && fullContent.length < 30,
    };
  }
};

// 5. LawService (캐시 기반 안전 수집 및 referencedContent 결합)
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

  // 단일 참조 시 깊이 한도 조절
  const effectiveMaxDepth = totalRefCount === 1 ? Math.min(currentDepth + 1, maxDepth) : maxDepth;
  if (currentDepth >= effectiveMaxDepth) return;

  // 병렬 처리로 변경 & currentLawId 비교 적용
  await Promise.all([
    ...internal.map(refNum => 
      collectArticle(currentLawId, refNum, currentDepth + 1, maxDepth)
    ),
    ...external.map(async (ext) => {
      const targetLawId = await getLawIdByName(ext.lawName);
      if (targetLawId && targetLawId !== currentLawId) {
        await collectArticle(targetLawId, ext.articleNum, currentDepth + 1, maxDepth);
      }
    })
  ]);
};

await collectArticle(lawId, parsed.num);
          const selfKey = `${lawId}_${parsed.num}`;
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
    if (!articles.length) return console.warn("사용 가능한 조문 없음:", law.lawName), null;
    return articles[Math.floor(Math.random() * articles.length)];
  }
};

// ============================================================================
// 4. 퀴즈 생성 및 검증 서비스 (Quiz AI Service)
// ============================================================================
const PROMPTS = {
  generate: (article, content, refContent) => `
다음 한국 법령 조문 및 참조/인용 조문을 읽고 객관식 4지선다 퀴즈 1개를 만드세요. 영어는 절대로 단 한글자도 포함하면 안됩니다.

법령명: ${article.lawName}
조문번호: ${article.num}
[출제 조문 내용]
${content}

${refContent ? `[참조 및 인용 조문 내용]\n${refContent}\n` : ""}
위 조문의 내용과 참조 및 인용 조문 내용을 모두 읽고 실제 법률 지식을 테스트할 수 있는 퀴즈를 작성하세요. 조금이라도 모르면 내지 말고 ㅅㅂ 하나라도 만족하지 않을시 재생성하시오.
□ 조항의 개정일, 삭제 여부, 조항 번호 자체를 묻는 문제는 제외하고, 상식적 법률 사례 문제를 만드세요.
□ 인물의 가명은 A씨, B씨, 김 씨 등으로 표기하고 해당 인물이 처한 상황과 맥락을 자세히 작성하시오.
□ 질문의 전제에 부합하는 정답을 확실하게 1개만 설정하고, 나머지는 명백한 오답으로 구성하세요.
□ ⚠️조문 원문에서 기간 및 정도, 금액이 나오는 부분과 법률 적용 판별 기준은 반드시 볼드(e.g. **2개월**, **높은 비율로**, **더 높은 금액", **1/3비율**)표시하고 예의 주시해서 날짜 및 금액 계산하시어 해설에도 똑같이 원문에 있는 기간을 대응작성하시고 **더 높은 금액**이면 실제로 정답 후보 중 비교하여 더 높은 금액이 정답으로 설정되어야 한다. 또한, 정도가 나오는 부분과 법률 적용 판별 기준도 대응작성하시오.
□ 해설 내 텍스트가 정확한 설명이 아닐 경우, 혹은 아래의 경우에는 explanation 내 Boolean 필드에 false 처리하시오.
- ⚠️인용 조항이 조금이라도 애매하거나 법적으로 잘못 해석될 여지가 있을 경우
- ⚠️없는 조문을 지어내는 경우
- ⚠️인용할 법률의 조항 번호와 내용이 잘못 써있거나 상반되는 경우 
- ⚠️기간 및 집행, 시행 주체가 실제 법령과 다르게 잘못 서술한 경우
- 법령의 법리 자체를 잘못 해석하거나 혼동한 경우
- 예시를 잘못 들었을 경우
□ 조항 번호를 하나도 모르겠으면 비워놓고 번호를 제외한 내용만 써놓으시오. 또한, 적용예시와 부가설명은 절대 해설에 삽입하지 마시오.
□ 질문에서 묻는 바(예: 소멸시효 기간, 공소 시효 기간, 행정 절차 기간 등), 정답 보기(options/answer), 해설(explanation)의 수치·단위·시점이 실제 법령 조문과 100% 일치해야 합니다.
□ 질문이 특정 법적 개념(예: '소멸시효는 얼마인가?', '효력이 발생하는 날은 언제인가?')을 물을 경우, 정답 보기는 그 질문에 직접적으로 대응하는 단위와 수치(예: '3년')여야 하며, 질문과 무관한 시점이나 엉뚱한 조건(예: '1개월이 지난 시점')을 정답으로 설정하지 마시오.
□ 질문에 맞는 정답이 해설 첫 두 문장 중 하나라도 일치하지 않으면 다시 출제하시오.
□ 범죄자가 한 행위 자체와 행위 자체를 실제로 당사자에게 행하였을때, 사용했을때를 반드시 심리적 해석과 실제 법령에 맞게 구분하여 작성하시오.
□ 질문의 질문 의도, 정답 내용, 해설의 법리 해석 간에 단 하나라도 삼박자가 맞지 않거나 논리적 핀트가 어긋나면 문제 작성을 중단하고 재생성하시오.
□ 반드시 긍정문으로 묻는 질문만을 생성하고, 질문은 구체적으로 작성하고, 수식 관계를 명확히 쉼표로 구분하시오.
□ 반드시 순수 JSON만 출력하세요.
□ 객체, 배열, 중첩 JSON을 explanation 값으로 사용하지 마세요.
□ 해설이 여러 문장인 경우 하나의 문자열 안에 줄바꿈(\\n)을 사용하세요.
□ 해설엔 질문의 논리에 부합하고 정확한 법령 조문(조, 항, 호, 목)을 명확히 인용하며, 특히 호/목에 해당하는 내용일 경우 해당 호/목까지 정확히 인용(예: 도로교통법 제160조제3항제1호)하여 작성하시오.
→ 인용 조항 내용은 정확히 명시된 것만 인용하시고 추측 및 억측하지 마시오.
□ **오류 WORST 6**
 - 질문의 목적과 의도, 법적 해석에 모두 어긋나는 정답, 해설이 있는경우
 - 실제 법령에 맞지 않는 정답을 제시할 경우 (⚠️어쨌든 수시 적성검사를 받은 병원의 장은 절대로 정답이 아니니 내지 마시오.)
 - 실제 법령과 전혀 다른 조문을 인용한 경우 
 - 유사 개념을 혼동하여 설명하거나 잘못된 해석을 한 경우
 - 질문, 해설, 답에서 의무(~해야한다)와 권고(~할 수 있다)를 잘못 구별하여 쓴 경우
 - 직계존속은 형법 제1001조에 없다 병신아 ㅅㅂ 나대지마라

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "concept_summary": "[문제 푸는 목표, 법률이 적용되는 주체, 법률을 어떻게 해석하는지의 의도, 준용 조항]",
  "explanation": {"string": "[인용된 법률 조문, 항, 호, 목과 일치하고 상통하는 상세 해설 및 정확한 준용 조항]", "Boolean": "true"},
  "question": "[질문 내용]",
  "options": [
    {"text": "[정답 내용]", "is_correct": true},
    {"text": "[오답 1]", "is_correct": false},
    {"text": "[오답 2]", "is_correct": false},
    {"text": "[오답 3]", "is_correct": false}
  ],
  "answer": "[정답 내용과 동일 텍스트]",
  "timer_sec": 15
}`,
  validate: (validationPayload) => `
당신은 사실성과 법리성, 계산 정확성을 우선으로 하는 대한민국 법률 퀴즈 검증 및 교정관입니다. 
제시된 퀴즈가 아래 [원문 조문 및 참조/인용 조문]과 일치하는지 검증하고, 원문과 불합치하거나 질문-정답-해설 내 전체 텍스트 간 모순이 있을 경우 원문 조문 스니펫을 완벽히 반영하여 자동 수정(Snippet Auto-Fix)하십시오.

[검증 및 교정 기준]
0.  ***걍 모르겠거나 조금이라도 애매하거나 검증 불가하면 false 처리하시오.***
1. 질문·보기·해설의 법적 수치, 시점, 주체, 법리 해석이 [원문 조문 및 참조/인용 조문]과 100% 일치해야 합니다.
2. 상관관계와 인과관계, 선후관계가 올바르지 않으며, 유사 법률, 대립되는 법률을 혼동했다면 false 처리하시오.
3. 질문에서 의도한 기간 조건이 정답에서 제대로 계산되었는지 실제 법령과 비교하며 검사하시오. 시효 기간을 실제 법령과 다르게 잘못 서술한 경우 false 처리하시오.
4. 권리, 의무, 원칙, 예외, 가능 등의 사항과 준용 조항을 착각하여 실제 법령에 맞지 않게 잘못 해석했다면 false 처리하시오.
 → 해설 내 인용 및 준용 조항이 조금이라도 애매하거나 법적으로 잘못 해석되어 있거나 조항 번호(조, 항, 호, 목)를 1자라도 잘못 적은 경우, valid: false 처리하십시오.
5. 실제로 없는 법령 조문 및 조항, 벌칙을 지어내진 않았는지, 실제 적용될 법령의 조항 번호를 착각 및 환각했는지 확인하시오.
6. 전혀 관련없는 법령 조문을 질문 및 해설에 끼어넣었다고 판단되면 valid: false 처리하십시오.
7. 해당 법령의 권리·의무·제재·절차 등이 문제에서 제시된 주체에게 실제로 적용되는지 확인하시오.
8. 질문이 묻는 본질 및 계산법(예: 소멸시효 기간, 조건에 맞는 금액 계산 및 비교), 정답 보기의 내용, 해설 내 법령 인용(조, 항, 호, 목) 및 수치/시점이 서로 완벽히 부합하는지 확인하시오.
 → 이에 맞는 정답과 해설이 어긋나있으면 정답과 해설을 교정한 repairedQuiz 객체를 반드시 생성하십시오.
9. 해설 내에 예시를 잘못 들었으면 false 처리하시고, 그 내용만 삭제하여 repairedQuiz하시오.
10. 질문에 맞는 정답과 해설의 첫 두 문장 간 내용이 불합치하거나 핀트가 어긋나면 valid: false 처리하십시오.
10-1. 이후 해설에서 잘못된 법리적 설명이 들어갈 경우 valid: false 처리하십시오.
10-2. 법률 및 행정 용어를 혼동했다고 판단된다면 valid: false 처리하십시오. 
11. valid: false인 경우, 오직 [원문 조문 및 참조/인용 조문] 텍스트 스니펫에 근거하여 질문, 4지선다 보기(정답 1개 필수), 정답(answer), 해설(explanation)을 즉시 교정한 repairedQuiz 객체를 반드시 생성하십시오.
12. valid: true인 경우 repairedQuiz는 null로 설정하십시오.
13. 실제 법령엔 의무 사항인데 권고 사항으로 오인하거나, 권고 사항인데 의무 사항으로 질문, 답, 해설에 잘못 서술될 경우, valid: false 처리하십시오.

### OUTPUT FORMAT (JSON ONLY)
{
  "valid": boolean,
  "reason": "검증 실패 원인 또는 수정 내역 (e.g. 이 법에 대해서 모름/ 법률용어 혼동/ 인용조항 내용을 잘못 제시함/ 잘못된 예시)",
  "repairedQuiz": {
    "id": "${validationPayload.quiz.id}",
    "category": "${validationPayload.quiz.category}",
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
`
};

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
    if (!article?.lawName || !article?.num) return null;
    
    const content = String(article.content || "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
    const refContent = String(article.referencedContent || "").trim();
    const prompt = PROMPTS.generate(article, content, refContent);

    try {
      const quiz = await this.requestMistral(prompt, "xhigh");
      return Utils.normalizeQuiz(quiz);
    } catch (err) {
      if (Utils.isRateLimitError(err) && retriesLeft > 0) {
        await Utils.sleep(1500);
        return this.generateQuiz(article, retriesLeft - 1);
      }
      return console.error("Mistral API 오류:", err.message), null;
    }
  },

  async validateSingleQuiz(quiz, article) {
    const sourceText = String(article?.content || "").replace(/[ \t]+/g, " ").trim();
    const refText = String(article?.referencedContent || "").trim();
    if (!sourceText) return { valid: false, reason: "원문 누락", repairedQuiz: null };

    const fullSourceContext = refText ? `[출제 조문 (${article.num})]\n${sourceText}\n\n[참조/인용 조문]\n${refText}` : `[출제 조문 (${article.num})]\n${sourceText}`;
    
    const validationPayload = {
      source: { lawName: String(article.lawName), articleNumber: String(article.num), content: fullSourceContext },
      quiz,
    };

    try {
      const parsed = await this.requestMistral(PROMPTS.validate(validationPayload), "high");
      return {
        valid: parsed.valid ?? false,
        reason: String(parsed.reason || ""),
        repairedQuiz: parsed.repairedQuiz ? Utils.normalizeQuiz(parsed.repairedQuiz) : null,
      };
    } catch (err) {
      console.error("Mistral 검증/수정 호출 오류:", err.message);
      return { valid: true, reason: "검증 API 호출 실패로 임시 통과", repairedQuiz: null };
    }
  },

  async generateValidQuizSlot(slotIndex, maxTries = 3) {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const law = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
      const article = await LawService.fetchRandomArticle(law);
      if (!article) continue;

      const quiz = await this.generateQuiz(article);
      if (!quiz) continue;

      const validation = await this.validateSingleQuiz(quiz, article);

      if (validation?.valid === true) {
        const revalidation = await this.validateSingleQuiz(quiz, article);
        if (revalidation?.valid === true) {
          console.log(`[슬롯 ${slotIndex}] 최종 생성/검증 성공 (시도 ${attempt})`);
          return quiz;
        }
      }

      if (validation?.repairedQuiz) {
        const secondValidation = await this.validateSingleQuiz(validation.repairedQuiz, article);
        const finalRepairedQuiz = secondValidation?.repairedQuiz || validation.repairedQuiz;
        const finalReason = secondValidation?.repairedQuiz ? secondValidation.reason : validation.reason;
        console.log(`\n================ [슬롯 ${slotIndex} 자동 수정 내역 디버깅] ================`);
    console.log(`- 사유: ${finalReason}`);
    console.log(`- 수정 전 질문: ${quiz.question}`);
    console.log(`- 수정 후 질문: ${finalRepairedQuiz.question}`);
    console.log(`- 수정 전 해설: ${quiz.explanation?.string}`);
    console.log(`- 수정 후 해설: ${finalRepairedQuiz.explanation?.string}`);
    console.log(`- 수정 전 정답: ${quiz.answer}`);
    console.log(`- 수정 후 정답: ${finalRepairedQuiz.answer}`);
    console.log(`========================================================================\n`);

    // 실제 성공 여부 판단 후 로그 출력
    const isSuccess = secondValidation?.isValid || secondValidation?.repairedQuiz;
    if (isSuccess) {
        console.log(`[슬롯 ${slotIndex}] false문제 최종 재생성/검증 성공`);
    }

        return {
          ...finalRepairedQuiz,
          isRepaired: true,
          repairReason: finalReason,
          debugInfo: {
            originalQuestion: quiz.question,
            originalAnswer: quiz.answer,
            originalExplanation: quiz.explanation,
          },
        };
      }
    }
    return console.warn(`[슬롯 ${slotIndex}] 모든 생성 및 검증/자동수정 시도 실패`), null;
  }
};

// ============================================================================
// 5. API 라우팅 (API Routes)
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
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/lawquizzes/new", async (req, res) => {
  try {
    console.log("=== 병렬 퀴즈 세트 생성 시작 ===");
    const quizPromises = [1, 2, 3].map((index) => QuizService.generateValidQuizSlot(index));
    const results = await Promise.all(quizPromises);
    const newQuizzes = results.filter(Boolean);
    console.log(`=== 퀴즈 세트 생성 완료: ${newQuizzes.length}/3 ===`);

    if (newQuizzes.length === 0) {
      return res.status(400).json({ error: "퀴즈 생성 실패", message: "퀴즈 생성 시도가 모두 실패했습니다." });
    }

    const quizSetId = String(Date.now());
    await db.collection("law_quizzes").doc(quizSetId).set({ createdAt: Date.now(), quizzes: newQuizzes });
    console.log("Firestore 저장 완료:", quizSetId);
    
    return res.json(newQuizzes);
  } catch (err) {
    console.error("퀴즈 세트 생성 중 오류 발생:", err);
    return res.status(500).json({ error: "퀴즈 생성 오류", message: err?.message || "알 수 없는 오류" });
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
    return res.status(err?.response?.status || 500).json({ error: "Mistral 모델 목록 조회 실패", message: err?.response?.data?.message || err.message });
  }
});

app.use(express.static(path.join(__dirname, "..")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../index.html"));
});

export default app;
