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
// 0. 체계적인 로깅 유틸리티 (Logger Utility)
// ============================================================================
const Logger = {
  timestamp: () => new Date().toISOString(),
  info: (tag, msg, data = "") => console.log(`[${Logger.timestamp()}] [INFO] [${tag}] ${msg}`, data !== "" ? data : ""),
  success: (tag, msg, data = "") => console.log(`[${Logger.timestamp()}] [SUCCESS] [${tag}] ${msg}`, data !== "" ? data : ""),
  warn: (tag, msg, data = "") => console.warn(`[${Logger.timestamp()}] [WARN] [${tag}] ${msg}`, data !== "" ? data : ""),
  error: (tag, msg, err = "") => console.error(`[${Logger.timestamp()}] [ERROR] [${tag}] ${msg}`, err?.message || err, err?.stack || "")
};

// ============================================================================
// 1. 설정 및 초기화 (Configuration & Init)
// ============================================================================
Logger.info("INIT", "=== 서버 환경 변수 및 설정 로드 시작 ===");
Logger.info("INIT", `LAW_GOV_OC: ${process.env.LAW_GOV_OC ? `존재 (${process.env.LAW_GOV_OC.substring(0, 5)}...)` : "없음 (필수)"}`);
Logger.info("INIT", `LAW_QUIZ_MISTRAL_KEY: ${process.env.LAW_QUIZ_MISTRAL_KEY ? "존재" : "없음 (필수)"}`);
Logger.info("INIT", `FIREBASE_SERVICE_ACCOUNT_KEY: ${process.env.FIREBASE_SERVICE_ACCOUNT_KEY ? "존재" : "없음 (필수)"}`);

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

// HTTP 요청 로깅 미들웨어
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    Logger.info("HTTP", `${req.method} ${req.originalUrl} -> 상태코드: ${res.statusCode} (${duration}ms)`);
  });
  next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;
let initializationError = null;

try {
  const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!rawKey) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY 환경 변수가 설정되지 않았습니다.");
  
  db = getFirestore(initializeApp({ credential: cert(JSON.parse(rawKey.trim())) }));
  Logger.success("FIREBASE", "Firebase Admin SDK 초기화 성공");
} catch (err) {
  Logger.error("FIREBASE", "Firebase Admin SDK 초기화 실패", err);
  initializationError = `Firebase Admin 초기화 실패: ${err.message}`;
}

app.use((req, res, next) => {
  if (!db) {
    Logger.error("DB_CHECK", "데이터베이스 미연결 상태로 요청 차단됨");
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
    const isRate = status === 429 || /429|rate.?limit/i.test(error?.message || "");
    if (isRate) Logger.warn("RATE_LIMIT", "Mistral API Rate Limit 감지됨");
    return isRate;
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
    if (!quiz || typeof quiz !== "object") {
      Logger.warn("NORMALIZE", "정규화 대상 퀴즈 데이터가 유효하지 않음", quiz);
      return null;
    }

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

    const cleanStr = (s) => String(s || "").replace(/\s+/g, "").trim();
    const targetAnswer = cleanStr(quiz.answer);

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

    const matchedIndex = rawOptions.findIndex(opt => getSimilarity(cleanStr(opt.text), targetAnswer) >= 0.9);
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
      options,
    };

    normalized.explanation.string = normalized.explanation.string
       .replace(/^\s*\[[^\]]*(스니펫|원문 조문|수정된 해설)[^\]]*\]\s*/g, "").trim();

    return normalized;
  }
};

// ============================================================================
// 3. 법령 데이터 파싱 및 범위 전개형 인용 분석 엔진
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
    Logger.info("LAW_CACHE", `법령명 매핑 완료: ${lawName} -> ID ${id}`);
    return String(id);
  };

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
  } catch (err) {
    Logger.warn("LAW_SEARCH", `lawSearch API 호출 실패 (${lawName}):`, err.message);
  }

  try {
    const { data } = await axios.get(LAW_API_URL, {
      params: { OC: OC_USER_ID, target: "law", type: "JSON", LM: lawName },
    });
    const id = data?.["법령"]?.["기본정보"]?.["법령ID"];
    if (id) return found(id);
  } catch (err) {
    Logger.warn("LAW_LM", `LM 파라미터 조회 실패 (${lawName}):`, err.message);
  }
  return null;
}

async function getLawArticleMap(lawId) {
  if (lawArticlesCache.has(lawId)) return lawArticlesCache.get(lawId);

  try {
    Logger.info("LAW_FETCH", `법령 전문 API 호출 중 (ID: ${lawId})`);
    const { data } = await axios.get(LAW_API_URL, {
      params: { OC: OC_USER_ID, type: "JSON", target: "eflaw", ID: lawId },
    });

    const joData = data?.["법령"]?.["조문"]?.["조문단위"] || data?.["법령"]?.["조문"];
    if (!joData) {
      Logger.warn("LAW_FETCH", `조문 데이터가 존재하지 않음 (ID: ${lawId})`);
      return new Map();
    }

    const lawName = data?.["법령"]?.["기본정보"]?.["법령명_한글"] || "";
    const articleMap = new Map();

    (Array.isArray(joData) ? joData : [joData]).forEach((art) => {
      const parsed = LawParser.parseArticle(art, lawName);
      if (parsed.num && !parsed.isDeleted) articleMap.set(parsed.num, parsed);
    });

    lawArticlesCache.set(lawId, articleMap);
    Logger.success("LAW_FETCH", `법령 조문 맵 로드 성공: [${lawName}] 총 ${articleMap.size}개 조문`);
    return articleMap;
  } catch (err) {
    Logger.error("LAW_FETCH", `법령 Map 로드 실패 (ID: ${lawId})`, err);
    return new Map();
  }
}

function expandCitationRanges(text) {
  if (!text) return text;
  let processed = text;
  const rangeRegex = /제\s*(\d+)\s*(조|항|호)\s*부터\s*제\s*(\d+)\s*(조|항|호)\s*까지/g;
  
  processed = processed.replace(rangeRegex, (match, startNum, startUnit, endNum, endUnit) => {
    if (startUnit !== endUnit) return match;
    const start = parseInt(startNum, 10);
    const end = parseInt(endNum, 10);
    if (isNaN(start) || isNaN(end) || start > end || (end - start) > 50) return match;
    
    const items = [];
    for (let i = start; i <= end; i++) {
      items.push(`제${i}${startUnit}`);
    }
    return items.join(", ");
  });

  return processed;
}

function extractReferences(content) {
  if (!content) return { internal: [], external: [] };

  const expandedContent = expandCitationRanges(content);
  const internal = [];
  const external = [];
  
  const lawCitationRegex = /(?:「([^」]+)」|([가-힣]+법))\s*(제\s*\d+\s*조(?:의\s*\d+)?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호)?)/g;
  let match;
  while ((match = lawCitationRegex.exec(expandedContent)) !== null) {
    const lawName = match[1] || match[2];
    const artFull = match[3].replace(/\s+/g, "");
    const artNumMatch = artFull.match(/제(\d+조(?:의\d+)?)/);
    if (lawName && artNumMatch) {
      external.push({ lawName, articleNum: artNumMatch[0] });
    }
  }

  const internalRegex = /제\s*(\d+)\s*조(?:의\s*(\d+))?/g;
  while ((match = internalRegex.exec(expandedContent)) !== null) {
    const artStr = `제${match[1]}조${match[2] ? `의${match[2]}` : ""}`;
    if (!internal.includes(artStr)) {
      internal.push(artStr);
    }
  }

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
        
        if (hNo === "0") hNo = "";

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

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟";

function hangLabelOf(hangText) {
  const m = String(hangText || "").match(/^\s*([①-⑳㉑-㉟])(?:\s*의\s*(\d+))?/);
  return m ? `제${CIRCLED.indexOf(m[1]) + 1}항${m[2] ? `의${m[2]}` : ""}` : null;
}

function extractClauseCitations(parsed) {
  const hangs = parsed?.hang?.length ? parsed.hang : [parsed?.content || ""];
  const out = [];

  for (const hangText of hangs) {
    const expandedHangText = expandCitationRanges(hangText);
    const fromHang = hangLabelOf(hangText);
    const lines = String(expandedHangText).split("\n");
    let currentHo = null;
    let currentMok = null;

    for (const raw of lines) {
      let m;
      if ((m = raw.match(/^ {4}([가-하])\./))) {
        currentMok = `${m[1]}목`;
      } else if ((m = raw.match(/^ {2}(\d+)(?:\s*의\s*(\d+))?\./))) {
        currentHo = `제${m[1]}호${m[2] ? `의${m[2]}` : ""}`;
        currentMok = null;
      } else if (!/^\s/.test(raw)) {
        currentHo = null;
        currentMok = null;
      }

      const citeRegex = /(?:(제\s*\d+\s*조(?:의\s*\d+)?))?\s*(?:(제\s*\d+\s*항))?\s*(?:(제\s*\d+\s*호))?\s*([가-하]\s*목)?/g;
      let cMatch;
      while ((cMatch = citeRegex.exec(raw)) !== null) {
        if (!cMatch[1] && !cMatch[2] && !cMatch[3] && !cMatch[4]) continue;
        const art = cMatch[1] ? cMatch[1].replace(/\s+/g, "") : null;
        const hang = cMatch[2] ? cMatch[2].replace(/\s+/g, "") : null;
        const ho = cMatch[3] ? cMatch[3].replace(/\s+/g, "") : null;
        const mok = cMatch[4] ? cMatch[4].replace(/\s+/g, "") : null;

        if (art === parsed?.num && !hang && !ho && !mok) continue;

        const base = art || (hang ? "같은 조" : ho ? "같은 항" : "같은 호");
        const toLabel = [base, hang, ho, mok].filter(Boolean).join(" ");
        const snippet = raw.replace(/\s+/g, " ").trim();

        out.push({
          fromHang,
          fromHo: currentHo,
          fromMok: currentMok,
          toLabel,
          snippet: snippet.length > 40 ? snippet.substring(0, 40) + "..." : snippet
        });
      }
    }
  }
  return out;
}

function buildCitationNotes(collected, mainLawName, maxLines = 60) {
  const lines = [];
  const seen = new Set();

  for (const art of collected.values()) {
    const lawPrefix = art.lawName && art.lawName !== mainLawName ? `[${art.lawName}] ` : "";
    for (const c of extractClauseCitations(art)) {
      const from = [`${lawPrefix}${art.num}`, c.fromHang, c.fromHo, c.fromMok].filter(Boolean).join(" ");
      const key = `${from}>${c.toLabel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${from} → ${c.toLabel} 인용 (원문: "...${c.snippet}...")`);
      if (lines.length >= maxLines) return lines.join("\n");
    }
  }
  return lines.join("\n");
}

const LawService = {
  async fetchLawArticles(lawId) {
    if (!OC_USER_ID) {
      Logger.error("LAW_SERVICE", "LAW_GOV_OC 환경 변수가 설정되지 않았습니다.");
      return [];
    }
    try {
      const articleMap = await getLawArticleMap(lawId);
      return Array.from(articleMap.values());
    } catch (err) {
      Logger.error("LAW_SERVICE", `법령 조문 목록 조회 실패 (ID: ${lawId})`, err);
      return [];
    }
  },

  async collectReferences(lawId, parsed, out = {}) {
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
        if (targetLawId && targetLawId !== currentLawId) {
          await collectArticle(targetLawId, ext.articleNum, currentDepth + 1, effectiveMaxDepth);
        }
      }
    };

    const selfKey = `${lawId}_${parsed.num}`;
    await collectArticle(lawId, parsed.num);
    out.notes = buildCitationNotes(collected, parsed.lawName);

    Logger.info("REF_COLLECT", `참조 조문 수집 완료: 총 ${collected.size - 1}개 연계 조문 수집됨`);
    return Array.from(collected.entries())
      .filter(([k]) => k !== selfKey)
      .map(([, refArt]) => `[${refArt.lawName} ${refArt.num}]\n${refArt.content}`)
      .join("\n\n");
  },

  async fetchRandomArticle(law) {
    Logger.info("RANDOM_ARTICLE", `대상 법령 선택됨: ${law.lawName} (ID: ${law.lawId})`);
    const articles = await this.fetchLawArticles(law.lawId);
    const validArticles = articles.filter((art) => art?.content && art.content.length >= 30);
    if (!validArticles.length) {
      Logger.warn("RANDOM_ARTICLE", `유효한 조문이 존재하지 않음: ${law.lawName}`);
      return null;
    }

    const picked = validArticles[Math.floor(Math.random() * validArticles.length)];
    Logger.success("RANDOM_ARTICLE", `랜덤 조문 선정됨: ${law.lawName} ${picked.num}`);
    const out = {};
    const referencedContent = await this.collectReferences(law.lawId, picked, out);
    return { ...picked, referencedContent, citationNotes: out.notes || "" };
  }
};

// ============================================================================
// 4. 프롬프트 정의 (Prompts)
// ============================================================================
const randomOptionsTemplate = () => {
  const correctAnswer = "[정답 내용]";
  const wrongAnswers = ["[오답 내용]", "[오답 내용]", "[오답 내용]"];
  const pos = Math.floor(Math.random() * 4);
  let wrongIdx = 0;
  return Array.from({ length: 4 }, (_, i) =>
    i === pos
      ? `{"text": "${correctAnswer}", "is_correct": true}`
      : `{"text": "${wrongAnswers[wrongIdx++] || '[오답 내용]'}", "is_correct": false}`
  ).join(",\n    ");
};

const PROMPTS = {
  generate: (article, content, refContent) => `
다음 한국 법령 조문 및 참조/인용 조문을 읽고 객관식 4지선다의 퀴즈 1개를 한국어 문법에 맞게 만드세요. **영어 및 한자는 절대로 단 한글자도 포함하면 안됩니다.** 

법령명: ${article.lawName}
조문번호: ${article.num}
[출제 조문 내용]
${content}

${refContent ? `[참조 및 인용 조문 내용]\n${refContent}\n` : ""}
${article.citationNotes ? `[조문 내 인용 관계]\n${article.citationNotes}\n` : ""}
위 조문의 내용과 참조 및 인용 조문 내용을 모두 읽고 실제 법률 지식을 테스트할 수 있는 퀴즈를 작성하세요. **할루시네이션 엄금합니다.**

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "concept_summary": "[문제 푸는 목표 및 의도, 관련 조항 및 조항내용, 법률 행위의 주체와 객체, 수단]", 
  "calcul_check": "[날짜 및 숫자 계산식]",
  "explanation": {"string": "[상세 해설]", "Boolean": true},
  "question": "[질문 내용]",
  "options": [
    ${randomOptionsTemplate()}
  ],
  "answer": "[정답 내용]",
  "timer_sec": 15
}`,

  blindSolve: (quiz, articleContext, refContent) => `
당신은 대한민국 법률 시험 수험생입니다. 아래의 [참조 법령]을 바탕으로 [질문]과 [보기]를 읽고 정답을 고르세요.

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

출력 형식:
{
  "chosen_number": 1,
  "reason": "[풀이 이유]"
}`
};

// ============================================================================
// 5. 퀴즈 서비스 및 검증 파이프라인
// ============================================================================
function repairJson(s) {
  Logger.warn("JSON_REPAIR", "손상된 JSON 응답 감지, 복구 로직 실행 중...");
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
    let release;
    const nextInLine = new Promise((resolve) => { release = resolve; });
    const prevTail = this.queueTail;
    this.queueTail = nextInLine;

    await prevTail;

    const now = Date.now();
    const wait = this.lastCallAt + MISTRAL_MIN_INTERVAL_MS - now;
    if (wait > 0) {
      Logger.info("THROTTLE", `API 호출 간격 조절 대기 중: ${wait}ms`);
      await Utils.sleep(wait);
    }
    this.lastCallAt = Date.now();
    release();
  },

  async requestMistral(prompt, reasoningEffort) {
    await this.throttle();
    Logger.info("MISTRAL_REQ", `Mistral API 요청 전송 (모델: ${MODEL}, reasoning_effort: ${reasoningEffort})`);
    
    const response = await client.chat.complete({
      model: MODEL,
      responseFormat: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      reasoning_effort: reasoningEffort,
    });
    
    let content = response?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      Logger.error("MISTRAL_RES", "Mistral 응답 내용이 문자열이 아님", content);
      return null;
    }
    
    const cleaned = content.replace(/^\s*```json\s*/i, "").replace(/^\s*```\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      Logger.success("MISTRAL_RES", "Mistral JSON 응답 파싱 성공");
      return parsed;
    } catch (parseErr) {
      Logger.warn("MISTRAL_RES", "직접 JSON 파싱 실패, 수리(repairJson) 시도", parseErr.message);
      const repaired = JSON.parse(repairJson(cleaned));
      Logger.success("MISTRAL_RES", "손상된 JSON 수리 및 파싱 성공");
      return repaired;
    }
  },

  async generateQuiz(article, retriesLeft = 2) {
    if (!article?.lawName || !article?.num || !article?.content || article.content.length < 30) {
      Logger.warn("QUIZ_GEN", "유효하지 않은 조문 데이터로 퀴즈 생성 중단됨");
      return null;
    }
    
    Logger.info("QUIZ_GEN", `퀴즈 생성 시작: [${article.lawName} ${article.num}]`);
    const content = String(article.content || "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
    const refContent = String(article.referencedContent || "").trim();
    const prompt = PROMPTS.generate(article, content, refContent);

    try {
      const rawQuiz = await this.requestMistral(prompt, "xhigh");
      const normalized = Utils.normalizeQuiz(rawQuiz);
      Logger.success("QUIZ_GEN", `퀴즈 생성 및 정규화 완료 (ID: ${normalized?.id})`);
      return normalized;
    } catch (err) {
      Logger.error("QUIZ_GEN", `퀴즈 생성 중 오류 발생 (남은 재시도: ${retriesLeft})`, err);
      if (Utils.isRateLimitError(err) && retriesLeft > 0) {
        Logger.info("QUIZ_GEN", "Rate Limit으로 인해 1.5초 후 재시도합니다.");
        await Utils.sleep(1500);
        return this.generateQuiz(article, retriesLeft - 1);
      }
      return null;
    }
  },

  validateRequiredFields(quiz) {
    if (!quiz || typeof quiz !== "object") {
      Logger.warn("VALIDATE", "검증 실패: 퀴즈 객체가 비어있음");
      return { valid: false, reason: "데이터 없음" };
    }
    if (!quiz.question || !quiz.answer || !quiz.explanation?.string) {
      Logger.warn("VALIDATE", "검증 실패: 필수 필드(질문, 정답, 해설) 누락됨", {
        hasQ: !!quiz.question,
        hasA: !!quiz.answer,
        hasExp: !!quiz.explanation?.string
      });
      return { valid: false, reason: "필수 필드 누락" };
    }
    if (!Array.isArray(quiz.options) || quiz.options.length !== 4) {
      Logger.warn("VALIDATE", `검증 실패: 보기 개수가 4개가 아님 (현재: ${quiz.options?.length})`);
      return { valid: false, reason: "보기 4개 아님" };
    }
    Logger.success("VALIDATE", "필수 필드 검증 통과");
    return { valid: true };
  },

  async validateBlindSolver(quiz, article, refContent) {
    Logger.info("BLIND_SOLVE", "블라인드 솔버 검증(수험생 페르소나 채점) 시작");
    try {
      const prompt = PROMPTS.blindSolve(quiz, article?.content || "", refContent);
      const res = await this.requestMistral(prompt, "high");
      const chosenNumber = Number(res?.chosen_number);
      
      if (!chosenNumber || chosenNumber < 1 || chosenNumber > 4) {
        Logger.warn("BLIND_SOLVE", `블라인드 솔버 응답 오류 (선택된 보기 번호: ${chosenNumber})`);
        return { valid: false, reason: "솔버 응답 오류" };
      }

      const isCorrect = quiz.options[chosenNumber - 1]?.is_correct === true;
      if (isCorrect) {
        Logger.success("BLIND_SOLVE", `블라인드 솔버 검증 통과 (솔버 선택: ${chosenNumber}번, 정답 일치)`);
      } else {
        Logger.warn("BLIND_SOLVE", `블라인드 솔버 검증 실패 (솔버 선택: ${chosenNumber}번은 오답임)`);
      }
      return { valid: isCorrect, reason: "정답 일치 여부" };
    } catch (err) {
      Logger.error("BLIND_SOLVE", "블라인드 솔버 실행 중 예외 발생", err);
      return { valid: false, reason: err.message };
    }
  },

  async generateValidQuizSlot(slotIndex, maxTries = 2) {
    Logger.info("SLOT_GEN", `--- 퀴즈 슬롯 #${slotIndex} 생성 파이프라인 시작 ---`);
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      Logger.info("SLOT_GEN", `시도 횟수: ${attempt}/${maxTries} (슬롯 #${slotIndex})`);
      const law = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
      const article = await LawService.fetchRandomArticle(law);
      if (!article) continue;

      const quiz = await this.generateQuiz(article);
      if (!quiz) continue;

      const step1 = this.validateRequiredFields(quiz);
      if (!step1.valid) continue;

      const step2 = await this.validateBlindSolver(quiz, article, article.referencedContent);
      if (step2.valid) {
        Logger.success("SLOT_GEN", `슬롯 #${slotIndex} 검증 완료된 최종 퀴즈 확보 성공!`);
        return quiz;
      }
      Logger.warn("SLOT_GEN", `슬롯 #${slotIndex} 블라인드 솔버 검증 탈락, 재시도 진행`);
    }
    Logger.error("SLOT_GEN", `슬롯 #${slotIndex} 퀴즈 생성 최종 실패 (최대 시도 횟수 초과)`);
    return null;
  }
};

// ============================================================================
// 6. API 라우팅
// ============================================================================
app.get("/api/lawquizzes/latest", async (req, res) => {
  Logger.info("ROUTE", "GET /api/lawquizzes/latest 요청 수신");
  try {
    const snapshot = await db.collection("law_quizzes").orderBy("createdAt", "desc").limit(1).get();
    if (snapshot.empty) {
      Logger.warn("ROUTE", "저장된 최신 퀴즈 셋이 존재하지 않음");
      return res.json([]);
    }
    const data = snapshot.docs[0].data();
    const quizzes = Array.isArray(data.quizzes) ? data.quizzes : Object.values(data.quizzes);
    Logger.success("ROUTE", `최신 퀴즈 조회 성공 (총 ${quizzes.length}개 항목)`);
    return res.json(quizzes);
  } catch (err) {
    Logger.error("ROUTE", "최신 퀴즈 조회 중 DB 오류 발생", err);
    return res.status(500).json({ error: err.message, serverError: true });
  }
});

app.post("/api/lawquizzes/new", async (req, res) => {
  Logger.info("ROUTE", "POST /api/lawquizzes/new (새로운 퀴즈 생성 요청) 수신");
  try {
    const slots = [1, 2, 3];
    const newQuizzes = [];
    
    for (let i = 0; i < slots.length; i += 2) {
      const chunk = slots.slice(i, i + 2);
      Logger.info("ROUTE", `병렬 퀴즈 슬롯 처리 중... 대상 슬롯: [${chunk.join(", ")}]`);
      const results = await Promise.all(chunk.map((idx) => QuizService.generateValidQuizSlot(idx)));
      newQuizzes.push(...results.filter(Boolean));
    }

    if (newQuizzes.length === 0) {
      Logger.error("ROUTE", "모든 슬롯에서 퀴즈 생성 실패");
      return res.status(500).json({ error: "퀴즈 생성 실패", serverError: true });
    }

    const quizSetId = String(Date.now());
    await db.collection("law_quizzes").doc(quizSetId).set({ createdAt: Date.now(), quizzes: newQuizzes });
    Logger.success("ROUTE", `새로운 퀴즈 셋 Firestore 저장 완료 (ID: ${quizSetId}, 생성된 퀴즈 수: ${newQuizzes.length})`);
    return res.json(newQuizzes);
  } catch (err) {
    Logger.error("ROUTE", "퀴즈 생성 엔드포인트 처리 중 예외 발생", err);
    return res.status(500).json({ error: err?.message, serverError: true });
  }
});

app.get("/api/mistral-models", async (req, res) => {
  Logger.info("ROUTE", "GET /api/mistral-models 요청 수신");
  try {
    const response = await axios.get("[https://api.mistral.ai/v1/models](https://api.mistral.ai/v1/models)", {
      headers: { Authorization: `Bearer ${process.env.LAW_QUIZ_MISTRAL_KEY}` },
    });
    const models = response.data?.data?.map(m => m.id) || [];
    Logger.success("ROUTE", `Mistral 모델 목록 조회 성공 (총 ${models.length}개 모델)`);
    return res.json({ models });
  } catch (err) {
    Logger.error("ROUTE", "Mistral 모델 목록 조회 실패", err);
    return res.status(500).json({ error: "조회 실패", serverError: true });
  }
});

app.use(express.static(path.join(__dirname, "..")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../index.html"));
});

export default app;
