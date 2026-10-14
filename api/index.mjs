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
  { lawId: "013704", lawName: "금융소비자 보호에 관한 법률" }, 
  { lawId: "000798", lawName: "저작권법" }
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

    // answer와 공백 제외 완전 일치하는 보기가 있을 때만 is_correct 플래그 보정
    const cleanStr = (s) => String(s || "").replace(/\s+/g, "").trim();
const targetAnswer = cleanStr(quiz.answer);

// 편집 거리 행렬을 이용한 유사도 계산 함수 (90% 이상 일치)
const getSimilarity = (s1, s2) => {
    const longer = s1.length > s2.length ? s1 : s2;
    if (longer.length === 0) return 1.0;
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else if (j > 0) {
                let newValue = costs[j - 1];
                if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return (longer.length - costs[s2.length]) / longer.length;
};

const matchedIndex = rawOptions.findIndex(opt => {
    return getSimilarity(cleanStr(opt.text), targetAnswer) >= 0.9;
});
    const options = matchedIndex !== -1
      ? rawOptions.map((opt, idx) => ({ ...opt, is_correct: idx === matchedIndex }))
      : rawOptions;

    const normalized = {
      ...quiz,
      id: this.normalizeText(quiz.id),
      category: this.normalizeText(quiz.category),
      explanation,
      question: this.normalizeText(quiz.question),
      answer: this.normalizeText(quiz.answer),
      timer_sec: Number(quiz.timer_sec) || 15,
      options, // 셔플 제거하여 LLM이 생성한 순서와 해설 번호가 100% 일치하도록 함
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

const normName = (s) => String(s || "").replace(/[\s「」]/g, "");
for (const l of VALID_LAW_IDS) lawIdCache.set(normName(l.lawName), l.lawId);

async function getLawIdByName(lawName) {
  const key = normName(lawName);
  if (lawIdCache.has(key)) return lawIdCache.get(key);
  const found = (id) => {
    if (!id) return null;
    lawIdCache.set(key, String(id));
    return String(id);
  };

  // 1) lawSearch: 페이지를 넘기며 정확 일치 (법령명 → 약칭 순)
  try {
    let abbrHit = null;
    for (let page = 1; page <= 5; page++) {
      const { data } = await axios.get("https://www.law.go.kr/DRF/lawSearch.do", {
        params: { OC: OC_USER_ID, target: "law", type: "JSON", query: lawName, display: 100, page },
      });
      const list = data?.LawSearch?.law;
      const items = list ? (Array.isArray(list) ? list : [list]) : [];
      const hit = items.find((it) => normName(it?.["법령명한글"]) === key);
      if (hit?.["법령ID"]) return found(hit["법령ID"]);
      if (!abbrHit) abbrHit = items.find((it) => normName(it?.["법령약칭명"]) === key);
      if (items.length < 100) break;
    }
    if (abbrHit?.["법령ID"]) return found(abbrHit["법령ID"]);
    console.warn(`[lawSearch 매칭 실패] ${lawName}`);
  } catch (err) {
    console.warn(`[lawSearch 실패] ${lawName}:`, err.message);
  }

  // 2) lawService LM(법령명) 폴백
  try {
    const { data } = await axios.get(LAW_API_URL, {
      params: { OC: OC_USER_ID, target: "law", type: "JSON", LM: lawName },
    });
    const id = data?.["법령"]?.["기본정보"]?.["법령ID"];
    if (id) return found(id);
    console.warn(`[LM 조회 빈 응답] ${lawName}:`, JSON.stringify(data).slice(0, 200));
  } catch (err) {
    console.warn(`[LM 조회 실패] ${lawName}:`, err.message);
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
  let lastLaw = null;
  const cleanContent = content.replace(
    /(?:「([^」]+)」|(같은\s*법)|([가-힣]+법))\s*(제\s*\d+\s*조(?:의\s*\d+)?)/g,
    (m, bracket, same, plain, art) => {
      const articleNum = art.replace(/\s+/g, "");
      if (same) {
        if (!lastLaw) return m; // 앞에 타법이 없으면 자기 법 참조로 둠
        external.push({ lawName: lastLaw, articleNum });
        return "";
      }
      lastLaw = (bracket || plain).replace(/\s+/g, " ").trim();
      external.push({ lawName: lastLaw, articleNum });
      return "";
    }
  );

  const internal = [...cleanContent.matchAll(/제\s*(\d+)\s*조(?:의\s*(\d+))?/g)]
    .map((m) => `제${m[1]}조${m[2] ? `의${m[2]}` : ""}`);

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
    
    if (!rawContent && (!rawNo || rawNo === "0")) return "";
    if (!rawContent) return `${indent}${rawNo}`;

    // 항번호가 존재하고 "0"이 아닌 경우에만 항/호 번호 접두사 적용
    if (rawNo && rawNo !== "0") {
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
    
    // 단일 조항(항번호 없음/0)인 경우 번호 없이 내용만 반환
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
        let hNo = String(h?.["항번호"] || "").trim();
        
        if (hNo === "0") hNo = ""; // "0"은 단일 조항이므로 번호 제거

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
      return Array.from(articleMap.values());
    } catch (err) {
      console.error(`법령 API 오류 (ID: ${lawId}):`, err.message);
      return [];
    }
  },

  // 뽑힌 조문 1개에 대해서만 참조 조문 수집
  async collectReferences(lawId, parsed) {
    const visited = new Set();
    const collected = new Map();

    const collectArticle = async (currentLawId, articleNum, currentDepth = 0, maxDepth = 3) => {
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
        console.log(`[타법 참조] ${ext.lawName} ${ext.articleNum} -> ${targetLawId}`);
        if (targetLawId && targetLawId !== currentLawId) {
          await collectArticle(targetLawId, ext.articleNum, currentDepth + 1, effectiveMaxDepth);
        }
      }
    };

    const selfKey = `${lawId}_${parsed.num}`;
    await collectArticle(lawId, parsed.num);

    return Array.from(collected.entries())
      .filter(([k]) => k !== selfKey)
      .map(([, refArt]) => `[${refArt.lawName} ${refArt.num}]\n${refArt.content}`)
      .join("\n\n");
  },

  async fetchRandomArticle(law) {
    const articles = await this.fetchLawArticles(law.lawId);
    const validArticles = articles.filter((art) => art?.content && art.content.length >= 30);
    if (!validArticles.length) return console.warn("사용 가능한 조문 없음 (30자 이상 조문 없음):", law.lawName), null;

    const picked = validArticles[Math.floor(Math.random() * validArticles.length)];
    const referencedContent = await this.collectReferences(law.lawId, picked);
    return { ...picked, referencedContent };
  }
};

// ============================================================================
// 4. 프롬프트 정의 (Prompts)
// ============================================================================
const randomOptionsTemplate = () => {
  const pos = Math.floor(Math.random() * 4);
  return Array.from({ length: 4 }, (_, i) =>
    i === pos
      ? `{"text": "[정답 내용]", "is_correct": true}`
      : `{"text": "[오답 내용]", "is_correct": false}`
  ).join(",\n    ");
};
const PROMPTS = {
  generate: (article, content, refContent) => `
다음 한국 법령 조문 및 참조/인용 조문을 읽고 객관식 4지선다의 퀴즈 1개를 한국어 문법에 맞게 만드세요. **영어 및 한자는 절대로 단 한글자도 포함하면 안됩니다.** 애미뒤졌으면 내지 마시오 ㅅㅂ.

법령명: ${article.lawName}
조문번호: ${article.num}
[출제 조문 내용]
${content}

${refContent ? `[참조 및 인용 조문 내용]\n${refContent}\n` : ""}
위 조문의 내용과 참조 및 인용 조문 내용을 모두 읽고 실제 법률 지식을 테스트할 수 있는 퀴즈를 작성하세요. **절대로 절대로 할루시네이션 엄금합니다.**
■ [핵심 작성 및 시점 검증 규칙]
1. **타임라인 및 사실관계 논리 완전성 (최우선)**
   - 문제에 등장하는 사건의 서순, 날짜, 시점, 조건 간 모순이 단 하나도 없어야 합니다.
   - 유사 법률 및 개념, 사실 관계, 상관 관계, 인과 관계, 선후 관계를 혼동하지 마시오.
   - 피상적이거나 확실하지 않고 Outdated한 정보는 출제하지 마시오.
   - 예: "소멸시효가 완성된 지 1년이 지났다"와 "작성 시점은 시효 완성 3개월 전이다"처럼 시점이 앞뒤가 맞지 않거나 현실적으로 불가능한 상황은 절대로 출제하지 마세요.
   - 시점(과거→현재→미래)과 법적 상태 변화를 타임라인순으로 철저히 검증한 후 문제를 구성하세요.

2. ***문제 및 보기 구성 조건***
   - 조항의 개정일, 삭제 여부, 조항 번호 자체를 묻는 문제는 제외하고 상식적 법률 사례 문제를 만드세요.
   - 인물의 가명은 A씨, B씨, 김 씨 등으로 표기하고 해당 인물이 처한 상황과 맥락을 상세히 작성하세요.
   - 반드시 **긍정문**으로만 묻고, 질문은 구체적으로 작성하세요. (간접 부정문 예: ~위반되지 않는다고 볼 수 있는가? 절대 금지)
   - 질문의 조건과 전제에 부합하는 정답을 확실하게 1개만 설정하고, 나머지는 질문의 조건과 전제에 확실히 부합하지 않으며, 정답과 완전히 상반되는 오답으로 구성하세요.

3. **볼드 표기 및 원문 일치**
   - 조문 원문에서 **기간, 정도, 금액, 법률 적용 판별 기준, 법률 행사 수단**은 반드시 볼드 처리(예: **2개월**, **높은 비율로**, **더 높은 금액**, **1/3 비율**, **조서**, **만 18세 미만**)하고, 날짜 및 금액 계산 시 정밀하게 적용하세요.
   - 질문, 정답 보기(options/answer), 해설(explanation)의 수치·단위·시점이 실제 법령 조문과 100% 일치해야 합니다.
   - **answer 필드 값**과 **정답 보기(is_correct=true)**의 텍스트가 반드시 **일치해야** 합니다.
   - 인물명에도 반드시 볼드처리 할것(예: **B씨**). 1대1로 대응 작성하시고 단일 인물만 있을 경우 단일 인물만 해설에 언급하시오.

4. **조문 인용 및 용어 엄격성 (Boolean: false 처리 기준)**
   - 존재하지 않는 법령명(예: '소비자보호법' 등)이 쓰인 경우 해설의 Boolean을 false 처리하세요.
   - '항(①, ② 등 원문자)'과 '호(1., 2. 등 숫자)'를 절대 혼동하지 말고 정확히 구분하세요.
   - 원문 조문에 항번호가 없거나 단일 조항인 경우, 임의로 '제1항'이나 '①' 등을 생성하지 말고 조문명(예: A법 제N조의M)만 언급하세요. 위반 시 Boolean을 false 처리하세요.
   - 옛날 명칭(예: 국가근로훈장, 국가공로훈장)을 사용했다면 Boolean을 false 처리하세요.
   - 해설에서 보기를 가리킬 때는 번호를 절대 사용하지 마세요.

5. ***해설 작성 및 검증 규칙 (Boolean: false 처리 기준)***
   - ***문제에 언급되지 않은 제3자(예: 문제에 없던 B씨, B상회 등)가 해설에 어느 곳이라도 갑자기 등장하면 Boolean을 false 처리하세요.***
   - ****선택지 내 키워드와 전혀 무관한 조항이 해설 내에 제시되었다면 Boolean을 false 처리하세요. 공표된 저작물 조항은 저작권법 제 40조, 제53조 등과는 관련없습니다.****
   - 날짜 계산이 틀리거나 시점(집행 시작/종료, 변제 시작 등) 서술 간 앞뒤 모순이 생기면 Boolean을 false 처리하세요.
   - 문제에 명시하지 않은 날짜/조건을 전제로 해설에서 언급되었다고 거짓말하면 Boolean을 false 처리하세요.
   - 조항 번호와 조항 내용이 불일치하거나 무관한 조항이 끼어있으면 Boolean을 false 처리하세요.
   - **입장을 명확히 구분하시오. 주체를 혼동하면 안됩니다. 주체를 혼동했다면 즉시 Boolean을 false 처리하세요.**
   - **오답 해설에서 실제 보기나 문제에 등장하지도 않은 엉뚱한 조항(예: 제141조 제2항 등)을 지어내어 언급하면 즉시 Boolean을 false 처리하세요.
   - 공탁절차 등 복잡하거나 불확실한 지식에 대해 할루시네이션하지 마시고, 모르는 내용은 해설에서 과감히 제외하세요.
   - 수치 및 계산 단어에 주의하세요. (예: '과반수 이상'이라는 모호한 표현 지양, '과반수'는 초과를 의미하므로 정확한 수학적 기준 적용)

6. 법령 원문에 기간이 전혀 명시되어 있지 않으면 절대로 날짜 등의 숫자를 문제나 해설에 넣지 마시오. 이 경우, calcul_check도 null로 비우시오.

7. **문법을 내가 그렇게 명확히 하라고 했는데, 말 ㅈㄴ 안듣네 ㅅㅂ 예 보여줄테니까 잘 봐.**
- 잘못된 예: A씨는 자신의 소설을 교과용도서로 편집하여 출판한 B상회가 학교교육 목적으로 해당 소설의 일부 표현을 변경하여 재출판하려 합니다. 다음 중 A씨가 이의를 제기할 수 없는 경우는?
- 올바른 예: A씨의 소설을 교과용도서로 편집하여 출판한 B상회가 학교교육 목적으로 해당 소설의 일부 표현을 변경하여 재출판하려 합니다. 다음 중 A씨가 이의를 제기할 수 없는 경우는?

8. **출력 형식**
   - 반드시 다른 부연 설명 없이 **순수 JSON** 형태만 출력하세요. 해설 내에선 오답 번호, 기호를 절대로 적지 마시오. **정답지 배치는 어디까지나 예시이며, 정답은 1번일수도 있고, 3번일 수도 있습니다.**

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "concept_summary": "[문제 푸는 목표 및 의도, 관련 조항 및 조항내용]", 
  "calcul_check": "[문제, 해설 내 올바른 날짜 및 숫자 계산식 모두 (예1: 2016-02-14의 40일 전은 2016년 1월 5일| 예2: 3/5 = 5명의 조합원 중 과반수 이상 | 예3: 2015-02-28은 2015년 1월 1일보다 58일 늦다. |예4: 2025-03-14로부터 3영업일 이내 = 2025년 3월 19일 (→ 평일(15, 16) 제외하고 계산) )]",
  "explanation": {"string": "[인용된 법률 조문, 항, 호, 목과 일치하고 상통하는 상세 해설 및 오답 내 키워드와 관련된 조항 설명]", "Boolean": true},
  "question": "[질문 내용]",
  "options": [
    ${randomOptionsTemplate()}
  ],
  "answer": "[정답 내용]",
  "timer_sec": 15
}`,

  blindSolve: (quiz, articleContext, refContent) => `
당신은 대한민국 법률 시험 수험생입니다. 아래의 [참조 법령] 및 [참조 및 인용 조문 내용]을 바탕으로 [질문]과 [보기]를 읽고 정답을 고르세요. 날짜 계산이 있다면 그것도 정확하게 확인하여 푸시오.

[참조 법령]
${articleContext}

${refContent ? `[참조 및 인용 조문 내용]\n${refContent}\n` : ""}

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
**절대로 해설에서 실제 보기나 문제에 없는 엉뚱한 조항(예: 제141조 제2항 등)을 지어내어 언급하지 마십시오.**

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
5. 정답(answer)과 해설(explanation)의 논리가 서로 일관성이 100% 있어야 하며, 완전하게 일치해야 한다.
6. 해설 내에 날짜 및 숫자 계산이 완전히 정확히 되어있어야 한다. [예1: "2026년 10월 15일의 6개월 이전" = "2026년 4월 15일" | 예2: 3/5 = 과반수(2.5) 이상이 맞음]
7. 또한, 해설 내 조항번호와 그 내용이 일치하지 않으면 안된다. 선택지 내 키워드와 전혀 무관한 조항이 해설 내에 제시되었다면 해당 내용을 제거하시오.
8. 날짜는 맞게 계산해놓고 해설에 앞뒤 모순이 생기면 안된다고.
9. 만약 질문 자체만 보고 계산 및 판단을 할 수 없는 경우, 문제의 질문에 조건을 괄호 안에 추가하시오.
10. 질문이 언급되지 않은 인물이 해설 내에 어디라도 엉뚱히 있을 경우, 해당 내용을 제거하시오.
11. 해설에서 보기를 가리킬 때 "1번", "①", "오답 1", "오답 가" 같은 번호 표현을 쓰지 말고, 보기 내용을 직접 요약언급하시오.
12. 질문에서 의도하는 주체가 불일치하다면, 반드시 질문을 시정하여 고치시오.

`
};

// ============================================================================
// 5. 퀴즈 서비스 및 3단계 검증 파이프라인 (Quiz AI Service)
// ============================================================================

function repairJson(s) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (c === "\\") { out += c + (s[i + 1] ?? ""); i++; continue; }
    if (c === '"') {
      // 닫는 따옴표: 뒤에 } ] : 또는 ", "다음키": / , { / , [ 가 올 때만
      if (/^\s*(?:[}\]:]|,\s*(?:"[^"\n]{1,40}"\s*:|[{\[]))/.test(s.slice(i + 1))) { inStr = false; out += c; }
      else out += '\\"';
      continue;
    }
    if (c === "\n") { out += "\\n"; continue; }
    if (c === "\r") { continue; }
    if (c === "\t") { out += "\\t"; continue; }
    out += c;
  }
  return out;
}

const QuizService = {
  lastCallAt: 0,
  queueTail: Promise.resolve(),
  
  async throttle() {
    // 비동기 큐 뮤텍스로 race condition 방지 및 정확한 간격 보장
    let release;
    const nextInLine = new Promise((resolve) => { release = resolve; });
    const prevTail = this.queueTail;
    this.queueTail = nextInLine;

    await prevTail;

    const now = Date.now();
    const wait = this.lastCallAt + MISTRAL_MIN_INTERVAL_MS - now;
    if (wait > 0) {
      await Utils.sleep(wait);
    }
    this.lastCallAt = Date.now();
    release();
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
    const cleaned = content.replace(/^\s*```json\s*/i, "").replace(/^\s*```\s*/i, "").replace(/\s*```\s*$/i, "").trim();
try {
  return JSON.parse(cleaned);
} catch {
  return JSON.parse(repairJson(cleaned));
}
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

    if (/[1-4①-④]\s*번|보기\s*[1-4]|오답\s*[1-4A-C가-다]/.test(quiz.explanation.string)) {
  return { valid: false, reason: "해설에 보기 번호 참조가 있음" };
    }

    return { valid: true };
  },

  // 2단계: 블라인드 솔버 검증
  async validateBlindSolver(quiz, article, refContent) {
    try {
      const articleContext = String(article?.content || "").trim();
      const refContent = String(article.referencedContent || "").trim();
      const prompt = PROMPTS.blindSolve(quiz, articleContext, refContent);
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
  async runValidationPipeline(quiz, article, refContent) {
    const step1 = this.validateRequiredFields(quiz);
    if (!step1.valid) {
      console.warn(`  └ [1단계 실패] ${step1.reason}`);
      return { valid: false, step: 1, reason: step1.reason, quiz };
    }
    console.log("  └ [1단계 통과] 필수 필드 검증 성공");

    const step2 = await this.validateBlindSolver(quiz, article, refContent);
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
      
      const reStep2 = await this.validateBlindSolver(correctedQuiz, article, refContent);
      if (!reStep2.valid) return { valid: false, step: 2, reason: `재검증 블라인드 솔버 실패: ${reStep2.reason}`, quiz: correctedQuiz };
      
      console.log("  └ [재검증 통과] 수정된 퀴즈 정답 논리 일치 확인");
      return { valid: true, reason: "자동 수정 후 검증 통과", quiz: correctedQuiz };
    }
    
    console.log("  └ [2단계 통과] 블라인드 솔버 일치 확인");
    return { valid: true, reason: "초기 검증 파이프라인 통과", quiz };
  },

  async generateValidQuizSlot(slotIndex, maxTries = 2) {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const law = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
const article = await LawService.fetchRandomArticle(law);
if (!article) continue;

const refContent = article.referencedContent ?? "";
      console.log(`\n[슬롯 ${slotIndex}] 퀴즈 생성 및 검증 시도 (${attempt}/${maxTries}) - 대상: ${law.lawName} ${article.num}`);

      const quiz = await this.generateQuiz(article);
      if (!quiz) {
        console.warn(`[슬롯 ${slotIndex}] 퀴즈 생성 실패`);
        continue;
      }

      const result = await this.runValidationPipeline(quiz, article, refContent);
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
    console.log("== 청크 병렬 그룹 퀴즈 세트 생성 및 3단계 검증 시작 ===");
    const slots = [1, 2, 3];
    const newQuizzes = [];
    
    // 2개씩 묶어서 병렬 처리 (순차의 느린 속도 + 전체 동시 병렬의 API 부하 및 타임아웃 동시 해결)
    for (let i = 0; i < slots.length; i += 2) {
      const chunk = slots.slice(i, i + 2);
      const chunkPromises = chunk.map((index) => QuizService.generateValidQuizSlot(index));
      const results = await Promise.all(chunkPromises);
      newQuizzes.push(...results.filter(Boolean));
    }
    
    console.log(`=== 퀴즈 세트 생성 완료: ${newQuizzes.length}/3 ===`);

    if (newQuizzes.length === 0) {
      return res.status(500).json({ 
        error: "퀴즈 생성 실패", 
        message: "퀴즈 생성 및 검증 시도가 모두 실패했습니다.", 
        serverError: true 
      });
    }

    const quizSetId = String(Date.now());
    await db.collection("law_quizzes").doc(quizSetId).set({ createdAt: Date.now(), quizzes: newQuizzes });
    console.log("Firestore 저장 완료:", quizSetId);
    
    return res.json(newQuizzes);
  } catch (err) {
    console.error("퀴즈 세트 생성 중 오류 발생:", err);
    return res.status(500).json({ 
      error: "퀴즈 생성 오류", 
      message: err?.message || "알 수 없는 오류", 
      serverError: true 
    });
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

app.get("/api/debug-ref", async (req, res) => {
  const map = await getLawArticleMap(req.query.lawId || "001638"); // 도로교통법
  const arts = [...map.values()];
  const sample = arts.find((a) => /「[^」]+」\s*제\s*\d+\s*조/.test(a.content));
  res.json({
    articleCount: arts.length,
    hasBracketRef: !!sample,
    sample: sample && { num: sample.num, text: sample.content.slice(0, 300), refs: extractReferences(sample.content) },
    lawIdOfXingbeop: await getLawIdByName("형법"),
  });
});

app.get("/api/debug-search", async (req, res) => {
  try {
    const r = await axios.get("https://www.law.go.kr/DRF/lawSearch.do", {
      params: { OC: OC_USER_ID, target: "law", type: "JSON", query: req.query.q || "형법" },
    });
    res.json({ status: r.status, data: JSON.stringify(r.data).slice(0, 800) });
  } catch (e) {
    res.json({ error: e.message, status: e.response?.status, data: String(e.response?.data).slice(0, 500) });
  }
});

app.get("/api/debug-ext", async (req, res) => {
  const name = req.query.name || "자동차관리법";
  const id = await getLawIdByName(name);
  const map = id ? await getLawArticleMap(id) : new Map();
  const art = map.get(req.query.art || "제3조");
  res.json({ name, id, articleCount: map.size, artHead: art?.content?.slice(0, 150) ?? null });
});

app.get("/api/debug-collect", async (req, res) => {
  const lawId = req.query.lawId || "001638";
  const art = req.query.art || "제2조";
  const ref = await LawService.collectReferences(lawId, { num: art, lawName: "" });
  res.json({ art, length: ref.length, heads: ref.match(/^\[[^\]]+\]/gm) });
});

app.use(express.static(path.join(__dirname, "..")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../index.html"));
});

export default app;
