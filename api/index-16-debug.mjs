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
const MODEL = 'ministral-14b-latest';
const MODEL_TIER_FLAG = { modelChanged: false, tier: 'ministral-14b-latest', serverError: true };
const LAW_API_URL = "https://www.law.go.kr/DRF/lawService.do";
const MISTRAL_MIN_INTERVAL_MS = 800;

const VALID_LAW_IDS = [
  { lawId: "001444", lawName: "대한민국헌법" },
  { lawId: "001706", lawName: "민법" },
  { lawId: "001692", lawName: "형법" },
  { lawId: "009318", lawName: "전자상거래 등에서의 소비자보호에 관한 법률" },
  { lawId: "009708", lawName: "재난 및 안전관리 기본법 시행령" },
  { lawId: "001638", lawName: "도로교통법" },
  { lawId: "001248", lawName: "주택임대차보호법" },
  { lawId: "001206", lawName: "가사소송법" },
  { lawId: "013704", lawName: "금융소비자 보호에 관한 법률" } 
];

const client = new Mistral({ apiKey: process.env.LAW_QUIZ_MISTRAL_KEY, timeoutMs: 120000 });
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
  MODEL_TIER_FLAG.serverError = true;
}

app.use((req, res, next) => {
  if (!db) {
    return res.status(500).json({ error: "DB 연결 실패", message: initializationError, serverError: true, modelTierFlag: MODEL_TIER_FLAG });
  }
  next();
});

// ============================================================================
// 1-1. 요구사항 1: 법령 Plaintext 통합 패키지 생성 함수
// ============================================================================
function assembleQuizPlaintext(article, refContent, quiz) {
  let plaintext = `=== [법령 퀴즈 통합 데이터 패키지] ===\n`;
  plaintext += `법령명: ${article.lawName} ${article.num}\n\n`;
  plaintext += `--- 1. 출제 조문 원문 ---\n${article.content}\n\n`;
  if (refContent) {
    plaintext += `--- 2. 인용 및 참조 법령 ---\n${refContent}\n\n`;
  }
  plaintext += `--- 3. 문제 및 보기 ---\n`;
  plaintext += `질문: ${quiz.question}\n`;
  (quiz.options || []).forEach((opt, idx) => {
    plaintext += `보기 ${idx + 1}: ${opt.text} (${opt.is_correct ? "정답" : "오답"})\n`;
  });
  plaintext += `\n--- 4. 정답 및 해설 ---\n`;
  plaintext += `정답: ${quiz.answer}\n`;
  plaintext += `해설: ${quiz.explanation?.string || ""}\n`;
  return plaintext;
}

// ============================================================================
// 2. 유틸리티 및 계산 엔진 (Utilities & Calc)
// ============================================================================
const Calc = {
  isHoliday(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const solarHolidays = ['01-01', '03-01', '05-05', '06-06', '08-15', '10-03', '10-09', '12-25'];
    const md = dateStr.substring(5);
    if (solarHolidays.includes(md)) return true;
    if (year >= 2026 && md === '07-17') return true;

    const lunarHolidays = [
      '2024-02-09', '2024-02-10', '2024-02-11', '2025-01-28', '2025-01-29', '2025-01-30',
      '2026-02-16', '2026-02-17', '2026-02-18', '2027-02-06', '2027-02-07', '2027-02-08',
      '2028-01-26', '2028-01-27', '2028-01-28', '2029-02-12', '2029-02-13', '2029-02-14',
      '2030-02-02', '2030-02-03', '2030-02-04', '2024-05-15', '2025-05-05', '2026-05-24',
      '2027-05-13', '2028-05-02', '2029-05-20', '2030-05-09', '2024-09-16', '2024-09-17',
      '2024-09-18', '2025-10-05', '2025-10-06', '2025-10-07', '2026-09-24', '2026-09-25',
      '2026-09-26', '2027-09-14', '2027-09-15', '2027-09-16', '2028-10-02', '2028-10-03',
      '2028-10-04', '2029-09-21', '2029-09-22', '2029-09-23', '2030-10-11', '2030-10-12', '2030-10-13'
    ];
    if (lunarHolidays.includes(dateStr)) return true;

    const substituteHolidays = [
      '2024-02-12', '2024-05-06', '2025-03-03', '2025-05-06', '2026-03-02', 
      '2026-05-25', '2027-08-16', '2027-10-04', '2028-08-16', '2028-10-05', 
      '2029-03-02', '2029-05-07', '2029-09-24', '2030-03-04', '2030-05-06'
    ];
    if (substituteHolidays.includes(dateStr)) return true;

    return false;
  },

  addBusinessDays(startDate, days) {
    let d = typeof startDate === 'string' ? new Date(startDate.replace(/\./g, '-')) : new Date(startDate);
    let year = d.getFullYear();
    let month = d.getMonth();
    let date = d.getDate();

    let absDays = Math.abs(days);
    let step = days >= 0 ? 1 : -1;

    while (absDays > 0) {
      date += step;
      const current = new Date(year, month, date);
      const dayOfWeek = current.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

      if (!isWeekend && !this.isHoliday(current)) {
        absDays--;
      }

      year = current.getFullYear();
      month = current.getMonth();
      date = current.getDate();
    }

    return new Date(year, month, date);
  },

  date(base, y, m, val, type) {
    const [by, bm, bd] = String(base).split("-").map(Number);
    const tm = bm - 1 + m + y * 12;
    const ty = by + Math.floor(tm / 12), tmon = ((tm % 12) + 12) % 12;
    const last = new Date(ty, tmon + 1, 0).getDate();
    let t = new Date(ty, tmon, Math.min(bd, last));
    
    if (type === 'B' && val !== 0) {
      t = Calc.addBusinessDays(t, val);
    } else if (type === 'd' && val !== 0) {
      t.setDate(t.getDate() + val);
    }
    
    return `${t.getFullYear()}년 ${t.getMonth() + 1}월 ${t.getDate()}일`;
  },

  run(expr) {
    const s = String(expr).trim();
    let m = s.match(/^DATE\((\d{4}-\d{2}-\d{2}),\s*([+-]?\d+)[a-zA-Z]?,\s*([+-]?\d+)[a-zA-Z]?,\s*([+-]?\d+)([dB])\)$/);
    if (m) return Calc.date(m[1], +m[2], +m[3], +m[4], m[5]);
      
    m = s.match(/^NUM\(([\d+\-*/().\s|Math.ceil|Math.floor|Math.round]+)\)$/);
    if (m) {
      try {
        const v = Function(`"use strict"; return (${m[1]});`)();
        if (!Number.isFinite(v)) return null;
        const parts = String(v).split(".");
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        return parts.join(".");
      } catch { 
        return null; 
      }
    }
    return null;
  }
};

function parseCalcItem(item) {
  let s = item;
  if (s && typeof s === "object") s = s.expr || s.formula || s.value || Object.values(s).join(";");
  if (typeof s !== "string") return null;

  const eq = s.indexOf("=");
  const left = eq === -1 ? s : s.slice(0, eq);
  const right = eq === -1 ? "" : s.slice(eq + 1).trim();
  const semi = left.indexOf(";");
  const expr = (semi === -1 ? left : left.slice(semi + 1)).trim();

  if (/^(DATE|NUM)\s*\(/.test(expr)) {
    try {
      const res = Calc.run(expr);
      if (res !== null && res !== undefined && String(res).trim() !== "") return res;
    } catch (e) {}
  }
  return (right.split("(")[0].trim() || right) || null;
}

function applyCalc(quiz) {
  const list = Array.isArray(quiz.calcul_check) ? quiz.calcul_check : [];
  const vals = list.map(parseCalcItem);
  const sub = (v) => typeof v === "string" ? v.replace(/\{\{c(\d+)\}\}/g, (t, i) => vals[i - 1] ?? t) : v;

  const out = {
    ...quiz,
    question: sub(quiz.question), 
    answer: sub(quiz.answer), 
    explanation_answer: sub(quiz.explanation_answer),
    explanation: { ...quiz.explanation, string: sub(quiz.explanation?.string) },
    options: (quiz.options || []).map(o => ({ ...o, text: sub(o.text) })),
  };

  const left = JSON.stringify(out).match(/\{\{c\d+\}\}/g);
  if (left) console.warn(`  └ calcul_check 원본: ${JSON.stringify(quiz.calcul_check)}`);
  out.calcError = left ? `미치환 토큰 존재: ${left.join(",")}` : "";
  return out;
}

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

  normalizeLawNotation: function (text, currentNum) {
    text = String(text ?? "");
    if (currentNum) {
      const matchNum = String(currentNum).match(/제(\d+)조(?:의(\d+))?/);
      if (matchNum) {
        const baseNum = parseInt(matchNum[1], 10);
        text = text.replace(/전\s*(\d+)?\s*조/g, (m, n) => {
          const offset = n ? parseInt(n, 10) : 1;
          const targetNum = baseNum - offset;
          return targetNum > 0 ? `제${targetNum}조` : m;
        });
      }
    }
    return text
      .replace(/제\s*(\d+)\s*조\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*호\s*(\d+)\.?/g, (_, n, ch, h) => `제${n}조제${circled(ch)}항제${h}호`)
      .replace(/제\s*(\d+)\s*조\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*(\d+)\.?/g, (_, n, ch, h) => `제${n}조제${circled(ch)}항제${h}호`)
      .replace(/제\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*(?:항)?\s*(\d+)\.?/g, (_, ch, h) => `제${circled(ch)}항제${h}호`)
      .replace(/제\s*(\d+)\s*조\s*제\s*(\d+)\s*항\s*(\d+)\.?/g, '제$1조제$2항제$3호')
      .replace(/제\s*(\d+)\s*조\s*(\d+)항\s*(\d+)\.?/g, '제$1조제$2항제$3호')
      .replace(/제\s*(\d+)\s*조\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*항/g, (_, n, ch) => `제${n}조제${circled(ch)}항`)
      .replace(/제\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*항/g, (_, ch) => `제${circled(ch)}항`)
      .replace(/제\s*(\d+)\s*조\s*제\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*항/g, (_, n, ch) => `제${n}조제${circled(ch)}항`)
      .replace(/제\s*(\d+)\s*조\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])(?!\s*조)/g, (_, n, ch) => `제${n}조제${circled(ch)}항`)
      .replace(/제\s*(\d+)\s*조\s*제\s*(\d+)\s*항/g, '제$1조제$2항')
      .replace(/제\s*(\d+)\s*항\s*제\s*(\d+)\s*호/g, '제$1항제$2호')
      .replace(/제\s*(\d+)\s*조\s*(\d+)호/g, '제$1조제$2호');
  },

  normalizeQuiz: function (quiz, articleNum) {
    if (!quiz || typeof quiz !== "object") return null;
    quiz = applyCalc(quiz);

    const fixGrammarAndTimeline = (text) => {
      if (typeof text !== "string") return text;
      return text
        .replace(/(\d+년\s*\d+월\s*\d+일)\s*부터\s*(지나기\s*전|이내에)/g, "$1부터 $2")
        .replace(/\s{2,}/g, " ")
        .trim();
    };

    const explanation = (() => {
      const rawExpl = quiz.explanation;
      if (rawExpl && typeof rawExpl === "object" && !Array.isArray(rawExpl)) {
        const boolVal = rawExpl.Boolean ?? rawExpl.boolean ?? false;
        return {
          string: fixGrammarAndTimeline(this.normalizeLawNotation(this.normalizeText(rawExpl.string ?? rawExpl.text ?? ""), articleNum)),
          Boolean: typeof boolVal === "boolean" ? boolVal : String(boolVal).toLowerCase() === "true"
        };
      }
      return { string: fixGrammarAndTimeline(this.normalizeLawNotation(this.normalizeText(rawExpl), articleNum)) , Boolean: true };
    })();

    const rawOptions = (Array.isArray(quiz.options) ? quiz.options : []).map(opt => ({
      text: this.normalizeText(opt?.text ?? opt),
      is_correct: opt?.is_correct === true,
    }));

    const cleanStr = (s) => String(s || "").replace(/\s+/g, "").trim();
    
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

    const expText = this.normalizeText(quiz.explanation_answer || "");
    const ansText = this.normalizeText(quiz.answer || "");
    
    const exactIndexes = (value) => {
      const key = cleanStr(value);
      if (!key) return [];
      return rawOptions
        .map((option, index) => cleanStr(option.text) === key ? index : -1)
        .filter(index => index !== -1);
    };

    const flaggedIndexes = rawOptions
      .map((option, index) => option.is_correct ? index : -1)
      .filter(index => index !== -1);

    const expMatches = exactIndexes(expText);
    const ansMatches = exactIndexes(ansText);
    let targetIndex = -1;

    if (flaggedIndexes.length === 1) {
      targetIndex = flaggedIndexes[0];
    } else {
      const expIndex = expMatches.length === 1 ? expMatches[0] : -1;
      const ansIndex = ansMatches.length === 1 ? ansMatches[0] : -1;

      if (expIndex !== -1) {
        targetIndex = expIndex;
      } else if (ansIndex !== -1) {
        targetIndex = ansIndex;
      } else {
        const queryStr = cleanStr(expText || ansText);
        if (queryStr) {
          const scored = rawOptions
            .map((option, index) => ({
              index,
              score: getSimilarity(cleanStr(option.text), queryStr),
            }))
            .sort((a, b) => b.score - a.score);

          if (scored[0]?.score >= 0.4) {
            targetIndex = scored[0].index;
          }
        }
      }
    }

    if (targetIndex === -1 && flaggedIndexes.length > 0) {
      targetIndex = flaggedIndexes[0];
    } else if (targetIndex === -1) {
      targetIndex = 0;
    }

    const options = rawOptions.map((opt, idx) => ({
      ...opt,
      is_correct: idx === targetIndex
    }));

    const normalized = {
      ...quiz,
      id: this.normalizeText(quiz.id || `quiz-${Date.now()}`),
      category: this.normalizeText(quiz.category),
      explanation,
      question: fixGrammarAndTimeline(this.normalizeText(this.normalizeLawNotation(quiz.question, articleNum))),
      answer: targetIndex !== -1 ? rawOptions[targetIndex].text : fixGrammarAndTimeline(this.normalizeText(this.normalizeLawNotation(quiz.answer, articleNum))),
      timer_sec: Number(quiz.timer_sec) || 15,
      options: options.map(opt => ({ ...opt, text: fixGrammarAndTimeline(this.normalizeLawNotation(opt.text, articleNum)) })),
    };
    
    normalized.explanation.string = normalized.explanation.string
       .replace(/^\s*\[[^\]]*(스니펫|원문 조문|수정된 해설|해설)[^\]]*\]\s*/g, "")
       .replace(/해설의 Boolean은 true[^.\n]*\./g, "")
       .replace(/^\s*\[([\s\S]*)\]\s*$/, '$1')
       .trim();

    return normalized;
  }
};

// ============================================================================
// 3. 법령 데이터 파싱 및 서비스 (Law Service)
// ============================================================================
const lawIdCache = new Map();
const lawArticlesCache = new Map();

let lawQueue = Promise.resolve();
function lawSlot(fn) {
  const run = lawQueue.then(fn, fn);
  lawQueue = run.then(() => Utils.sleep(250), () => Utils.sleep(250));
  return run;
}

async function lawGet(url, params, timeout = 16000, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return (await lawSlot(() => axios.get(url, { params: { OC: OC_USER_ID, type: "JSON", ...params }, timeout }))).data;
    } catch (err) {
      if (i >= tries || (err.response && err.response.status < 500)) throw err;
      await Utils.sleep(1000 * i);
    }
  }
}

async function getLawIdByName(lawName) {
  if (lawIdCache.has(lawName)) return lawIdCache.get(lawName);
  try {
    const data = await lawGet("https://www.law.go.kr/DRF/lawSearch.do", { target: "law", query: lawName }, 16000);
    const lawList = data?.LawSearch?.law;
    if (!lawList) return null;

    const items = Array.isArray(lawList) ? lawList : [lawList];
    const matched = items.find((item) => String(item?.["법령명한글"] || "").replace(/\s+/g, "") === lawName.replace(/\s+/g, "")) || items[0];

    const lawId = String(matched?.["법령일련번호"] || "");
    if (lawId) {
      lawIdCache.set(lawName, lawId);
      return lawId;
    }
  } catch (err) {
    console.error(`법령 검색 실패 (${lawName}):`, err.message);
  }
  return null;
}

function getLawArticleMap(lawId) {
  if (!lawArticlesCache.has(lawId)) {
    const p = loadLawArticleMap(lawId);
    lawArticlesCache.set(lawId, p);
    p.then((m) => { if (!m.size) lawArticlesCache.delete(lawId); });
  }
  return lawArticlesCache.get(lawId);
}

async function loadLawArticleMap(lawId) {
  try {
    const data = await lawGet(LAW_API_URL, { target: "law", MST: lawId });
    const joData = data?.["법령"]?.["조문"]?.["조문단위"] || data?.["법령"]?.["조문"];
    if (!joData) return new Map();

    const lawName = data?.["법령"]?.["기본정보"]?.["법령명_한글"] || "";
    const articleMap = new Map();

    (Array.isArray(joData) ? joData : [joData]).forEach((art) => {
      const parsed = LawParser.parseArticle(art, lawName);
      if (parsed.num && !parsed.isDeleted) articleMap.set(parsed.num, parsed);
    });

    return articleMap;
  } catch (err) {
    console.error(`법령 Map 로드 실패 (ID: ${lawId}):`, err.message);
    return new Map();
  }
}

const joCode = (num) => {
  const m = String(num).match(/제(\d+)조(?:의(\d+))?/);
  return m ? m[1].padStart(4, "0") + (m[2] || "0").padStart(2, "0") : null;
};

async function getArticle(mst, num) {
  const jo = joCode(num);
  if (!jo) return null;

  try {
    const data = await lawGet(LAW_API_URL, { target: "law", MST: mst, JO: jo });
    const raw = data?.["법령"]?.["조문"]?.["조문단위"];
    const lawName = data?.["법령"]?.["기본정보"]?.["법령명_한글"] || "";
    const found = (Array.isArray(raw) ? raw : [raw]).filter(Boolean)
      .map((a) => LawParser.parseArticle(a, lawName))
      .find((a) => a.num === num && !a.isDeleted);
    
    if (found) return found;
  } catch (err) {}

  try {
    const articleMap = await getLawArticleMap(mst);
    const cached = articleMap.get(num);
    return (cached && !cached.isDeleted) ? cached : null;
  } catch (err) {
    return null;
  }
}

const delegatedCache = new Map();
const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v.flat(Infinity) : [v]);
const artKey = (n, g) => `제${n}조${g && g !== "0" ? `의${g}` : ""}`;

function getDelegatedMap(lawId) {
  if (!delegatedCache.has(lawId)) {
    const p = (async () => {
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const data = await lawGet(LAW_API_URL, { target: "lsDelegated", MST: lawId }, 43000, 1);
          const map = new Map();
          for (const it of toArr(data?.lsDelegated?.["법령"]?.["위임조문정보"])) {
            const j = it["조정보"] || {};
            const key = artKey(j["조문번호"], j["조문가지번호"]);
            map.set(key, [...toArr(map.get(key)), ...toArr(it["위임정보"])]);
          }
          return map;
        } catch (err) {
          if (attempt === maxRetries) {
            delegatedCache.delete(lawId);
            return new Map();
          }
          await Utils.sleep(1100);
        }
      }
    })();
    delegatedCache.set(lawId, p);
  }
  return delegatedCache.get(lawId);
}

function delegatedRefs(infos, selfName) {
  const out = [];
  for (const w of toArr(infos)) {
    const kinds = toArr(w["위임구분"]);
    let previousClause = null;
    let previousArticleTitle = "";
    let previousLawName = selfName;

    for (const e of toArr(w["위임법령조문정보"])) {
      const nums = String(e["위임법령조문번호"] ?? "0").split(",").map((n) => n.trim());
      const text = e["라인텍스트"] || "";
      const named = text.match(/「([^」]+)」/)?.[1];
      const clauseKey = String(e["조항호목"] ?? "").trim();
      const articleTitle = String(e["위임법령조문제목"] ?? "").trim();

      const previousTitleWords = previousArticleTitle.split(/\s+/).filter(Boolean);
      const currentTitleWords = articleTitle.split(/\s+/).filter(Boolean);
      const hasSharedTitleWord = previousTitleWords.some(word => currentTitleWords.includes(word));

      let targetLawName;
      if (named) {
        targetLawName = named;
        previousLawName = named;
      } else if (clauseKey && clauseKey === previousClause && hasSharedTitleWord) {
        targetLawName = previousLawName;
      } else {
        targetLawName = selfName;
      }

      previousClause = clauseKey;
      previousArticleTitle = articleTitle;
      previousLawName = targetLawName;

      if (targetLawName === "시행령" || targetLawName === "시행규칙") {
        targetLawName = `${selfName} ${targetLawName}`;
      } else if (kinds.includes("시행령") && !targetLawName.endsWith("시행령")) {
        targetLawName = `${targetLawName} 시행령`;
      } else if (kinds.includes("시행규칙") && !targetLawName.endsWith("시행규칙")) {
        targetLawName = `${targetLawName} 시행규칙`;
      }

      const kind = kinds[0] || "인용법령";
      if (!["인용법령", "시행령", "시행규칙", "위임법령"].includes(kind)) continue;

      const gajis = String(e["위임법령조문가지번호"] ?? "").split(",").map((n) => n.trim());
      nums.forEach((n, i) => {
        if (n && n !== "0") {
          out.push({
            kind,
            lawName: targetLawName,
            num: artKey(n, gajis[i] || "0"),
            from: e["조항호목"],
            lineText: text,
          });
        }
      });
    }
  }
  return out;
}

const circled = (ch) => {
  const c = ch?.charCodeAt(0) ?? 0;
  return c >= 0x2460 && c <= 0x2473 ? c - 0x2460 + 1 : c >= 0x3251 && c <= 0x325f ? c - 0x3251 + 21 : 0;
};
const cmpNo = ([a, b], [c, d]) => a - c || b - d;

function sliceRange(art, text) {
  const head = art.content.split("\n")[0];
  let m = text.match(/(\d+)항부터\s*(?:제\s*)?(\d+)항/);
  if (m) {
    const picked = art.hang.filter((h) => circled(h[0]) >= +m[1] && circled(h[0]) <= +m[2]);
    return picked.length ? [head, ...picked].join("\n") : art.content;
  }
  m = text.match(/(\d+)호(?:의(\d+))?부터\s*(?:제\s*)?(\d+)호(?:의(\d+))?/);
  if (m) {
    const [a, b] = [[+m[1], +(m[2] || 0)], [+m[3], +(m[4] || 0)]];
    const ctx = +(text.match(/제(\d+)항(?=제\s*\d+호)/)?.[1] || 0);
    const hang = ctx ? art.hang.find((h) => circled(h[0]) === ctx) : art.hang.join("\n");
    if (!hang) return art.content;
    const lines = hang.split("\n");
    const out = [lines[0]];
    let keep = false;
    for (const line of lines.slice(1)) {
      const n = line.match(/^ {2}(\d+)(?:의(\d+))?\./);
      if (n) keep = cmpNo([+n[1], +(n[2] || 0)], a) >= 0 && cmpNo([+n[1], +(n[2] || 0)], b) <= 0;
      if (keep) out.push(line);
    }
    return out.length > 1 ? [head, ...out].join("\n") : art.content;
  }
  return art.content;
}

function extractReferences(content) {
  if (!content) return { internal: [], external: [] };

  const external = [];
  const addExt = (lawName, articleNum) => external.push({ lawName, articleNum });

  const bracketCleaned = content.replace(
    /「([^」]+)」\s*((?:제\s*\d+\s*조(?:\s*의\s*\d+)?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호)?(?:\s*(?:부터|까지|및|또는|,|ㆍ|과|와)\s*)?)+)/g,
    (m, lawName, run) => {
      const name = lawName.trim();
      const rest = run.replace(
        /제\s*(\d+)\s*조(?:\s*의\s*\d+)?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호)?\s*부터\s*(?:제\s*)?(\d+)\s*조/g,
        (mm, a, b) => { for (let n = +a; n <= +b; n++) addExt(name, `제${n}조`); return " "; }
      );
      for (const x of rest.matchAll(/제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g)) addExt(name, `제${x[1]}조${x[2] ? `의${x[2]}` : ""}`);
      return " ";
    }
  );

  const cleanContent = bracketCleaned.replace(
    /([가-힣]+법)\s*(제\s*\d+\s*조(?:의\s*\d+)?)/g,
    (match, lawName, articleNum) => {
      external.push({ lawName, articleNum: articleNum.replace(/\s+/g, "") });
      return "";
    }
  );

  const internalSet = new Set();
  const articleRangeRegex = /제\s*(\d+)\s*조(?:의\s*(\d+))?\s*(?:부터|부터는)\s*(?:제\s*)?(\d+)\s*조(?:의\s*(\d+))?/g;
  let rangeMatch;
  let processedContent = cleanContent;

  while ((rangeMatch = articleRangeRegex.exec(cleanContent)) !== null) {
    const startNum = parseInt(rangeMatch[1], 10);
    const startGaji = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : 0;
    const endNum = parseInt(rangeMatch[3], 10);
    const endGaji = rangeMatch[4] ? parseInt(rangeMatch[4], 10) : 0;

    if (startNum === endNum) {
      internalSet.add(`제${startNum}조${startGaji ? `의${startGaji}` : ""}`);
    } else if (startNum < endNum) {
      for (let n = startNum; n <= endNum; n++) {
        internalSet.add(`제${n}조`);
      }
    }
    processedContent = processedContent.replace(rangeMatch[0], "");
  }

  const hangRangeRegex = /(?:제\s*)?(\d+)\s*항\s*(?:부터|부터는)\s*(?:제\s*)?(\d+)\s*항/g;
  while ((rangeMatch = hangRangeRegex.exec(processedContent)) !== null) {
    processedContent = processedContent.replace(rangeMatch[0], "");
  }

  const hoRangeRegex = /(?:제\s*)?(\d+)\s*호\s*(?:부터|부터는)\s*(?:제\s*)?(\d+)\s*호/g;
  while ((rangeMatch = hoRangeRegex.exec(processedContent)) !== null) {
    processedContent = processedContent.replace(rangeMatch[0], "");
  }

  const internalMatches = [...processedContent.matchAll(/제\s*(\d+)\s*조(?:의\s*(\d+))?/g)];
  internalMatches.forEach((m) => {
    internalSet.add(`제${m[1]}조${m[2] ? `의${m[2]}` : ""}`);
  });
  const internal = Array.from(internalSet);

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

  parseSubItems(container, childKey, noKey, contentKey, nextChildKey, nextNoKey, nextContentKey, indent, parentHangNo) {
    if (!container) return [];
    const items = Array.isArray(container[childKey]) ? container[childKey] : container[childKey] ? [container[childKey]] : [];

    const lines = [];
    items.forEach(item => {
      const rawNo = String(item[noKey] || "").trim();
      const rawContent = String(item[contentKey] || "").trim();
      
      let formattedNo = rawNo;
      if (childKey === "호" && parentHangNo) {
        formattedNo = `제${parentHangNo}항 제${rawNo.replace(/[^\d의]/g, "")}호`;
      } else if (childKey === "목") {
        formattedNo = `${rawNo}목`;
      } else {
        formattedNo = "제" + rawNo.replace(/[^\d의]/g, "") + "호";
      }

      const line = rawContent ? `${indent}${formattedNo} ${rawContent}` : `${indent}${formattedNo}`;
      if (line) lines.push(line);

      if (nextChildKey && item[nextChildKey]) {
        const subLines = this.parseSubItems(
          item, nextChildKey, nextNoKey, nextContentKey, null, null, null, indent + "  ", parentHangNo
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
        let hNo = String(h?.["항번호"] || "").trim();
        const hText = String(h?.["항내용"] || "").trim();

        if (hNo === "0") hNo = "";

        if (hText) {
          let cleanHText = hText;
          if (articleHeader && cleanHText.startsWith(articleHeader)) {
            cleanHText = cleanHText.replace(articleHeader, "").trim();
          }
          if (cleanHText) hLines.push(hNo ? `제${hNo}항 ${cleanHText}` : cleanHText);
        }

        if (h?.["호"]) {
          const hoLines = this.parseSubItems(h, "호", "호번호", "호내용", "목", "목번호", "목내용", "  ", hNo);
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

const dec = (s) => String(s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const bylText = (b) => {
  const rawContent = toArr(b["별표내용"]).flat(Infinity);
  const lines = rawContent.map((s) => String(s || "").replace(/<[^>]*>/g, "").trim()).filter(Boolean);

  const cleaned = lines
    .join("\n")
    .replace(/[┏┓┗┛━┃┣┫┳┻╋│├└┘┌┐]/g, " ")
    .replace(/[■□◆◇ㆍ]/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();

  return dec(cleaned);
};

function extractTableReferences(content) {
  if (!content) return [];
  const regex = /별표\s*(\d+)(?:의(\d+))?/g;
  const matches = [...content.matchAll(regex)];
  const results = [];
  
  for (const m of matches) {
    results.push({ no: Number(m[1]), sub: m[2] ? Number(m[2]) : 0 });
  }
  
  const unique = [];
  const set = new Set();
  for (const r of results) {
    const key = `${r.no}_${r.sub}`;
    if (!set.has(key)) {
      set.add(key);
      unique.push(r);
    }
  }
  return unique;
}

async function fetchSpecificTable(lawId, lawName, targetNo, targetSub) {
  try {
    const data = await lawGet(LAW_API_URL, { target: "law", MST: lawId });
    const list = toArr(data?.["법령"]?.["별표"]?.["별표단위"]);
    if (!list.length) return null;

    const matched = list.find((b) => Number(b["별표번호"] || 0) === Number(targetNo) && Number(b["별표가지번호"] || 0) === Number(targetSub));
    if (!matched) return null;

    const tag = Number(matched["별표가지번호"] || 0) > 0 ? `별표 ${matched["별표번호"]}의${matched["별표가지번호"]}` : `별표 ${matched["별표번호"]}`;
    return `[${lawName} ${tag}]\n${dec(bylText(matched))}`;
  } catch (err) {
    return null;
  }
}

const LawService = {
  async fetchLawArticles(lawId) {
    if (!OC_USER_ID) return [];
    try {
      return Array.from((await getLawArticleMap(lawId)).values());
    } catch (err) {
      return [];
    }
  },

  async collectRefs(law, parsed) {
    const lawId = law.lawId;
    const visited = new Set();
    const collected = new Map();
    const tablesCollected = [];

    const tableRefs = extractTableReferences(parsed.content);
    await Promise.all(tableRefs.map(async (ref) => {
      const tableText = await fetchSpecificTable(lawId, law.lawName, ref.no, ref.sub);
      if (tableText) tablesCollected.push(tableText);
    }));

    const collectArticle = async (key, articleNum, currentDepth = 0, maxDepth = 3, opt = {}) => {
      if (!articleNum) return;
      const vk = `${key}_${articleNum}`;
      const alreadyVisited = visited.has(vk);
      if (alreadyVisited && !opt.lineText) return;
      visited.add(vk);

      const found = await getArticle(key, articleNum);
      if (!found || found.isDeleted) return;

      const ck = `${found.lawName}_${found.num}`;
      const article = opt.lineText ? { ...found, content: sliceRange(found, opt.lineText) } : found;
      const outputKey = opt.lineText ? `${ck}|${opt.kind || ""}|${opt.from || ""}|${opt.lineText}` : ck;
      if (!collected.has(outputKey)) collected.set(outputKey, { article, opt });

      if (alreadyVisited || opt.kind === "시행령" || opt.kind === "시행규칙" || currentDepth >= maxDepth) return;

      const { internal, external } = extractReferences(article.content);
      const internalPromises = internal.map(refNum => collectArticle(key, refNum, currentDepth + 1, maxDepth));
      const externalPromises = external.map(async (ext) => {
        const targetLawId = await getLawIdByName(ext.lawName);
        if (targetLawId && targetLawId !== key) {
          await collectArticle(targetLawId, ext.articleNum, currentDepth + 1, maxDepth);
        }
      });

      await Promise.all([...internalPromises, ...externalPromises]);
    };

    const dmap = await getDelegatedMap(lawId);
    const delegatedTasks = delegatedRefs(dmap.get(parsed.num), law.lawName).map(async (r) => {
      const key = r.lawName === law.lawName ? lawId : await getLawIdByName(r.lawName);
      if (key) await collectArticle(key, r.num, 1, 1, r);
    });
    
    await Promise.all(delegatedTasks);
    await collectArticle(lawId, parsed.num);

    const articleRefs = Array.from(collected.values())
      .filter(({ article: a }) => !(a.lawName === parsed.lawName && a.num === parsed.num))
      .map(({ article: a, opt }) => {
        const label = opt.from ? `${opt.from} ${opt.kind === "인용법령" ? "인용" : "위임"} → ` : "";
        return `[${label}${a.lawName} ${a.num}]\n${a.content}`;
      });

    return [...tablesCollected, ...articleRefs].join("\n\n");
  },

  async fetchRandomArticle(law) {
    const mst = await getLawIdByName(law.lawName);
    if (!mst) return null;
    const articles = await this.fetchLawArticles(mst);
    const validArticles = articles.filter((art) => art?.content && art.content.length >= 30);
    if (!validArticles.length) return null;
    const article = validArticles[Math.floor(Math.random() * validArticles.length)];
    return { ...article, referencedContent: await this.collectRefs({ ...law, lawId: mst }, article) };
  }
};

// ============================================================================
// 4. 프롬프트 정의 (Prompts - 복수정답 방지 및 부정문/긍정문 진위 검사 강화)
// ============================================================================
const randomOptionsTemplate = () => {
  const pos = Math.floor(Math.random() * 3);
  const options = [];
  for (let i = 0; i < 3; i++) {
    options.push({
      text: i === pos ? "[정답 내용이면서 질문의 전제 및 진위에 부합하며 질문 내에 언급된 인물의 사실 및 사항.]" : "[오답 내용이면서 질문의 전제 및 진위에 부합하지 않고 질문 내에 언급된 인물의 사실 및 사항.]",
      is_correct: i === pos
    });
  }
  return options.map(o => JSON.stringify(o)).join(",\n    ");
};

const PROMPTS = {
  generate: (article, content, refContent) => `
너는 엄격한 논리로 파고드는 전 범위의 법률 전문가이다. 다음 한국 법령 조문 및 참조/인용 조문을 읽고 정답 위치가 다른 객관식 3지선다의 퀴즈 1개를 한국어 문법에 알맞게 만들어. **영어는 안된다. 단, 조문 원문의 한자는 한글로 변환하여 사용하거나, 괄호 안의 한자는 제거하라.**
***출제자는 날짜 및 숫자 계산에 신중해야 하며, 항상 최선을 다해야 한다.*** 반드시 3지선다형 퀴즈!!!!!!!!!!!

법령명: ${article.lawName}
조문번호: ${article.num}
[출제 조문 내용]
${content}

${refContent ? `[참조 및 인용 조문 내용]\n${refContent}\n` : ""}
위 조문의 내용과 참조 및 인용 조문 내용을 모두 읽고 실제 법률 지식을 테스트할 수 있는 퀴즈를 작성하세요.
###[★ 절대 금지 규칙: REJECT]
1. 조문 번호나 항/호 자체를 묻는 문제 금지.
2. 법령상 특정 상황이나 구성요건의 충족 여부를 결정하는 수치·비율·금액·기간 등 **기준값 자체를 묻는 경우 부정형 질문(틀린 것은?, 옳지 않은 것은?)을 금지한다.** 복수정답 발생을 방지하기 위해 긍정형 질문으로만 출제한다.
단, 단순히 수치·금액·기간이 선택지에 포함되어 있다는 이유만으로 이 규칙을 적용하지 않는다. 질문의 핵심이 해당 기준값 자체를 확인하는 경우에만 적용한다.
→ 예: 금융소비자 보호에 관한 법률에서 소액분쟁사건의 조정절차 적용 기준 금액으로 틀린 것은? (금지)
→ 수정: 금융소비자 보호에 관한 법률에서 소액분쟁사건의 조정절차 적용 기준 금액으로 **옳은 것은**? (허용)

### [★ 복수 정답 원천 차단 및 긍정/부정 진위 규칙]
1. **정답은 반드시 오직 1개여야 하며, 나머지 오답은 서로 내용의 의미와 그 맥락이 동일하면 안된다. 이는 사실상 같은 조항의 규정을 사용했다는 의미가 되고 문제의 조건을 제대로 보지 않았다는 방증이기 때문이다.**
2. **질문 유형별 진위 규칙**:
   - 질문이 긍정형(예: "옳은 것은?", "맞는 것은?", "~할 수 있는 것은?")이면, **오직 1개의 정답 보기만 법적으로 참(True)**이어야 하고, 나머지 2개의 오답 보기는 기간, 주체, 요건 등을 왜곡하여 **명백한 거짓(False)**이어야 합니다.
   - 질문이 부정형(예: "틀린 것은?", "~가 아닌 것은?", "~할 수 없는 것은?")이면, **오직 1개의 정답 보기만 법적으로 성립하지 않는 거짓(False)**이어야 하고, 나머지 2개의 오답 보기는 **명백한 참(True)**이어야 합니다.
3. 조문 안에 참인 내용이 여러 개 있다고 해서 **다른 참인 법리를 오답 보기에 절대 섞지 마십시오.** 복수 정답이 발생하는 순간 치명적인 오류가 됩니다.
4. 계산 수식이나 날짜/금액 계산이 필요한 경우 'calcul_check'를 적극 활용하고 본문에는 {{c1}}, {{c2}} 플레이스홀더를 사용하세요.
5. "법이 적용되는 경우에 대한 설명으로 틀린 것은?" 이라고 물었을 때에는 정답에 해당 법령과 전혀 반대의 성격을 가거나 법령에 언급이 전혀 없는 설명이 들어가야 한다.

###[ 문장 품질 및 출제 규칙 - 필수]
1. 문제·보기·정답·해설은 자연스럽고 정확한 현대 한국어로 작성한다.
2. 질문은 쟁점 하나를 간결하게 묻고, 보기와 직접 연결되게 작성한다. 사실관계, 인과관계, 상관관계가 정확하고 예시, 예외사항의 적용이 모두 적절해야 한다. 또한, 법령 조항번호 제시가 필요한 경우 조항번호 전체를 다 드러내야 한다. (예: 1항 3호 (X) → 5조 1항 3호 (○) )
3. 법률상 권리·권한·절차와 주체, 객체, 권리자, 의무자를 서로 바꾸어 쓰지 않는다.
4. 보기 세 개는 각각 독립된 한 문장 혹은 어구로 작성한다.
5. 세 보기의 문장 구조와 종결 어미를 통일한다. 다만, 제출/명기해야 할 사항 혹은 필수사항/우선적 고려사항 등을 물을 때는 마침표없는 단어로 구성된 어구로 선택지를 작성할 것.
6. 유사 개념 혼동 금지 ("갈음" vs "면제", "취소" vs "중지" vs "정지" 등).
7. 해설은 3단계 단문 구조([결론], [법령 근거], [사안 대입])로만 작성한다. 질문에 사례와 가명이 없다면 [사안 대입]은 완전히 생략해야 한다.
8. 질문을 그대로 정답에 복사, 붙여넣기하지 마시오.
9. 조문 내 기간, 금액, 나이, 한정되는 대상(직계존속 등), 날짜 계산 오류 또는 시점 판별(WITHIN/EXPIRED)이 틀리면 절대로 안된다.
10. 법령에 나오는 접속사, 부사, 맞춤법, 연결어미 등을 혼동하여 절대로 틀리면 안된다. 해설에서 혼동했다면 해설의 Boolean은 false이다.
11. 법령 조항 내 의무와 권고를 혼동하지 마시오. 혼동했다면 해설의 Boolean은 false이다.
12. 대한민국 형법의 대원칙은 죄형법정주의에 있다. 또한, 특별법이 있다면 그 법이 우선으로 적용된다.
13. 다중으로 시행령이 적용되는 경우를 논리적으로 단계별로 생각해야만 한다. 억지로 추론할거라면 역순으로 추적해 생각하시오.
14. **요건 충족 여부와 선택지 구성** : 제출/명기해야 할 사항/필수 사항/우선적 고려사항을 제외하고는 공통적으로 "만", "도", "는" 등의 적절한 조사를 사용하여 맥락과 진위, 조건에 맞게 선택지를 만들어 쓰십시오.
   - "요건을 충족한/적법한 것"을 묻는 경우: 정답 보기에는 **후단의 단서가 적용되지 않는 한 법령요건을 모두 포함**시키고, 오답 보기에는 요건을 하나 이상 반대로 틀어 꼬거나 적합하지 않은 상황을 대입하십시오.
   - "위반되는 조항/행위"를 묻는 경우: 질문의 상황에서 **위반되는 모든 조항을 정답에 반영**하십시오.
   - "제출/명기해야 할 사항으로 틀린 것은?"이라고 묻는 경우: 맞는 선택지에는 실제로 법령에 명시된것을 대입하고, 틀린 선택지(정답)에는 실제로 법률에 해당 사항으로 명기 된 것 중 하나를 꼬아서 법률에 없는 조건인지 비교확인 후 설정하여 만드시오. (예: 사업 내용 → 사업자등록번호 / 설립 연열일 → 허가 연월일)
   - "~하는 행위 시 틀린 것은?" 이라고 묻는 경우 : 맞는 선택지에는 법령에 명시된 모든 법적 요건과 상황을 빠짐없이 전부 대입하거나(예: ~를 모두 켜야 한다) 명시된 법적 요건 중 하나를 넣고(예: ~는 ..되어있어야 한다.), 틀린 선택지(정답)에는 법령에 명시되어 있지 않지만 그럴듯한 매력적인 내용으로 설정하여 만드시오.


### [볼드체 강조 및 수치 검증]
1. 조문 원문 및 해설 작성 시 **기간, 정도, 금액, 명 수, 법률 적용 기준, 행사 수단, 한정 벙위**은 반드시 **볼드체**로 작성하십시오. (예: **2개월**, **높은 비율로**, **1/3 비율**, **만 18세 미만**, **20명**, **제한되지 않는 경우**, **제외하고**, **직계존속**)
2. 인물의 나이, 날짜, 명 수, 기간 계산(기산일~만료일)을 법령 원문 수치와 100% 일치하도록 정확히 계산하십시오.
3. 인물의 나이에 맞게 조건을 나누어 법리 해석하시오.

### [숫자 계산]
1. [증액·감액 기준] 증액·감액 문제는 직전 증액이 반영된 '청구 시점의 현재 약정액'을 기준으로 상한을 계산하십시오. 청구액이 현재 약정액보다 낮을 경우 절대 '증액'이라는 표현을 사용하지 마십시오.
2. [시공간 및 날짜 계산] 해설 작성 시 날짜 및 기간은 KST(UTC+9), 그레고리력 기준으로 계산합니다. 영업일 기준으로 계산할 때는 주말과 공휴일을 반드시 제외하십시오. 계산이 명확하지 않거나 올바르지 않으면 해설의 "Boolean" 값을 반드시 'false'로 처리하십시오.
3. [calcul_check 활용 및 치환] 날짜·금액·비율의 계산 결과는 텍스트(question, options, explanation)에 직접 숫자로 쓰지 마십시오. 오직 'calcul_check'에만 수식으로 작성하고, 본문에는 수식 순서에 따라 {{c1}}, {{c2}} 등의 플레이스홀더로 대체하십시오. (단, 문제에 사실관계로 주어진 최초 날짜/숫자는 그대로 기입 가능)
4. [calcul_check 수식 규칙] 계산할 수식, 숫자, 날짜가 없으면 'calcul_check'는 null로 두십시오. 법률의 조항번호(예: 제64조, 제2항 등)는 calcul_check 식의 NUM 내부에 절대 들어가지 않습니다.
5. [할루시네이션 방지 및 단어 정의] 숫자 및 날짜 계산에 대해 절대 임의의 억지 논리나 할루시네이션을 하지 마십시오. 
   - '과반수 이상'은 과반수 경계값을 포함한다는 뜻입니다. (e.g. 5명 중 과반수 이상 = 2.5명 이상이므로, 2.5명을 포함하여 3명부터 충족 가능)
   - 경과일수 계산 시 시작일과 종료일을 정확히 산정하십시오. (e.g. 3월 16일부터 4월 10일까지의 경과일수 = 총 26일)
   - (주의) 15/10=1.5를 반올림하면 2입니다. '10대당 3명' 같은 법정 비례 상수가 있다면 비례식을 "NUM(ceil(15 * 3 / 10))"과 같이 정확한 수학적 인과관계로 작성해야 하며, 수식 논리가 틀린 채 결과 숫자만 맞추는 행위는 불합격 처리됩니다.

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "concept_summary": "[문제 푸는 목표 및 의도, 문제 요약]",
  "calcul_check": "[계산할 항목명 및 계산식. 단, d일 이후에서 기준일은 포함하지 않고 산정 계산한다. 잘못됐을 경우 +1d을 하여라. B파라미터 쓸때는 주말, 공휴일 등을 제외하여 계산 산정. 날짜: DATE(기준일YYYY-MM-DD, +0y, +개월m, +일d) / 숫자: NUM(수식). 예1: 계약 종료 3개월 전; DATE(2016-05-22, +0y, -3m, +0d)=2016-02-22  예2: 100명 중 1/3; NUM(100/3)=50000 예3: 10영업일; DATE(2016-05-22, +0y, +0m, +10B)=2016-06-03]",
  "judicial_precedent": "[필요한 경우 법리에 맞는 대법원 판례]", 
  "explanation": {"string": "[상세 해설]", "Boolean": true},
  "question": "[질문]", 
  "explanation_answer": "[해설과 일치하는 정답 텍스트]",
  "options": [
   ${randomOptionsTemplate()}
  ],
  "answer": "[정답 내용이면서 질문의 전제 및 진위에 부합하며 질문 내에 언급된 인물의 사실 및 사항.]",
  "timer_sec": 15
}`,

  audit: (quiz, article, refContent) => `
너는 생성된 법률 퀴즈의 근거와 추론을 감사하는 검토자다. 아래 제공된 원문 및 인용법령을 근거로 퀴즈의 핵심 주장과 결론이 실제 뒷받침되는지 엄격히 검토하라.


### [★ 복수 정답 및 진위 엄격 검사 규칙]
1. **question_polarity**: 질문이 "~가 아닌 것은?", "~할 수 없는 것은?", "틀린 것은?" 등 부정형이면 "negative", "옳은 것은?", "맞는 것은?" 등 긍정형이면 "positive"로 정확히 분류하라.
- 부정형이면 정답(selected_option_index)에는 반드시 해당 법령에 언급되지 않거나 전혀 반대의 성격을 담은 설명문 혹은 설명 어구가 들어가야 한다.
2. **복수 정답 차단**: matches_question이 true인 선택지는 반드시 단 1개여야 한다. 0개이거나 2개 이상이면 즉시 pass=false 처리하라.
3. **진위 일치 검사**:
   - polarity가 "negative"인 경우, 정답 선택지의 statement_truth는 "false"여야 하고 나머지 두 오답 선택지의 statement_truth는 "true"여야 한다.
   - polarity가 "positive"인 경우, 정답 선택지의 statement_truth는 "true"여야 하고 나머지 두 오답 선택지의 statement_truth는 "false"여야 한다.
4. **해설 모순 검사**: 해설 본문의 결론과 정답 선택지 간에 모순이 있으면 exlanation_contradiction는 **true**여야 하며, 모순이 없어야만 **false**이다. (모순이 있으면 통과 불가)

#### [엄격 규칙]
1. 질문에 정답을 사실상 미리 알려주는 문장을 넣고 다시 같은 내용을 묻거나, 법률 용어를 잘못 조합하거나, 원문이 뒷받침하지 않는 추상적 평가를 덧붙였다면, 반드시 issues에 구체적으로 적고 pass=false로 판정한다.
2. 예외·단서·위임 규정·누적 요건, 한정 대상(예: 직계비속)이 있으면 각각의 적용 범위와 다른 법적 효과를 구분한다.

판정 기준:
- supported: 중요한 주장마다 원문 근거와 타당한 추론이 있고, 핵심 누락이나 모순이 없고 예외사항이나 단서 누락이 없다. 또한, 세 보기의 진위가 모두 타당하다고 검증됨.
- unsupported: 원문과 충돌하거나, 원문이 뒷받침하지 않는 결론·인용·추론이 있다. 또한, 법적 주체와 예외 단서가 맞지 않다.
- insufficient: 주어진 원문/사실만으로 결론과 보기의 진위를 확정할 수 없다.

[출제 대상 법령]
${article.lawName} ${article.num}
[출제 조문 원문]
${article.content}
[참조 및 위임 조문 원문]
${refContent || "제공된 참조 조문 없음"}
[생성된 퀴즈]
${JSON.stringify(quiz, null, 2)}

CASE>> 반드시 1) 또는 2)의 형태로 순수 JSON만 출력한다.

1) 긍정 질문일 경우
{
  "pass": true,
  "verdict": "supported",
  "question_polarity": "positive",
  "question_compatibility": true,
  "exlanation_contradiction": false, 
  "selected_option_index": 0,
  "option_assessments": [
    {"option_index": 0, "statement_truth": "true", "matches_question": true, "evidence_quote": "인용", "reasoning": "이유"},
    {"option_index": 1, "statement_truth": "false", "matches_question": false, "evidence_quote": "인용", "reasoning": "이유"},
    {"option_index": 2, "statement_truth": "false", "matches_question": false, "evidence_quote": "인용", "reasoning": "이유"}
   ],
  "issues": [],
  "claim_evidence": [{"claim": "주장", "evidence_quote": "근거", "reasoning": "추론"}]
  }
  
  2) 부정 질문일 경우
{
  "pass": true,
  "verdict": "supported",
  "question_polarity": "negative",
  "question_compatibility": true,
  "exlanation_contradiction": false, 
  "selected_option_index": 0,
  "option_assessments": [
    {"option_index": 0, "statement_truth": "false", "matches_question": true, "evidence_quote": "인용", "reasoning": "이유"},
    {"option_index": 1, "statement_truth": "true", "matches_question": false, "evidence_quote": "인용", "reasoning": "이유"},
    {"option_index": 2, "statement_truth": "true", "matches_question": false, "evidence_quote": "인용", "reasoning": "이유"}
   ],
  "issues": [],
  "claim_evidence": [{"claim": "주장", "evidence_quote": "근거", "reasoning": "추론"}]
  }`,

  correction: (quiz, article, errorReason) => `
당신은 대한민국 법률 퀴즈 출제자입니다. 다음 퀴즈는 검토 과정에서 복수 정답 또는 논리 오류가 발견되었습니다. 아래 오류 사유를 반영하여 수정하십시오.
[원문 조문]
${article.content}
${article.referencedContent ? `\n[참조 조문]\n${article.referencedContent}` : ''}
[오류 사유]
${errorReason}
[기존 퀴즈 데이터]
${JSON.stringify(quiz, null, 2)}

기존과 동일한 순수 JSON 형식으로만 출력하십시오.
[완벽한 문제 기준]
1. 유일하게 설정된 정답, 해설 내 수치(기간/금액/비율/나이/날짜/명 수), 시점, 법적 주체, 형량, 의무/권고 구분이 원문과 정확히 일치해야 한다. 조금이라도 추측이 들어갔다고 판단되면, 그 부분을 삭제해라.
2. 질문의 조건과 전제가 해설, 정답의 논리와 들어맞고 상통해야 한다.
3. 인용한 조항 번호(조, 항, 호, 목)가 실존하며 그 해설 내용과 상통해야 한다. 조금이라도 불일치하면 수정해라.
4. ***법률 적용 조건, 법률 행사 수단, 법리 해석(위임 법령도 모두 포함)이나 판례/예시/예외상황/한정범위 적용에 오류 및 모순이 없어야 하고, 법률 용어를 잘못 이해하는 실수가 없어야 한다.***
5. ****질문의 조건과 상황에 맞게 계산되었는지 다시 한 번 확인해라.****
5-1. 정답(answer)과 해설(explanation)의 논리가 서로 일관되며 날짜도 예외없이 완전하게 일치해야 한다. 일치하지 않으면 해설에 맞게 정답지를 수정해라. 수정 후 explanation_answer를 수정된 해설이 결론 낸 보기 문장으로 갱신하고, answer와 is_correct 보기의 text도 그 문장과 똑같이 맞춘다.
6. 해설 내에 날짜 및 숫자, 경과 일수 계산이 정확히 되어있어야 한다. [예1: "2026년 10월 15일의 6개월 이전" = "2026년 4월 15일" | 예2: 3/5 = 과반수(2.5) 이상이 맞음| 예3: 3월 16일부터 4월 10일까지의 경과일수 = 총 26일] 날짜가 맞지 않으면 해설에 맞게 정답지를 수정하여라.
7. 해설 내 조항번호와 그 내용이 일치하지 않으면 안된다.
8. 시간적으로 역설이 나타났을 경우 ( 나쁜 예: A씨는 2023년 1월 1일 체결된 주택임대차계약의 임대차기간이 만료되기 6개월 전인 2022년 7월 1일에 임대인 B사에게 계약갱신을 요구하였습니다.) 반드시 올바른 문장으로 고치시오.
(고친 예: A씨는 2023년 1월 1일 임대차 계약이 만료된다. 만료되기 6개월 전인 2022년 7월 1일에 임대인 B사에게 계약갱신을 요구하였습니다.) 
9. 후단의 단서를 간과하여 당사자의 책임을 면제하도록 잘못 해석하는 경우, 반드시 문장으로 고치고 단서를 적용하여 책임을 인용하도록 하시오.
10. 보기 및 해설 마지막 문장에서 "-거나", "-와 .. 모두", "직접" 등을 혼동하여 잘못 작성했다면 즉시 주의깊게 수정해야 한다.
만약 긍정 질문의 정답 아닌 보기나 부정 질문(-아닌 것은?)의 정답에서 잘못 작성된 것이 있다면은 그것은 완전히 방치한다.
11. 해설 본문의 결론의 방향이 반드시 일률적으로 일치하도록 해설을 수정하라.
`
};

function detectQuestionPolarity(question) {
  const q = String(question ?? "").replace(/\s+/g, "");
  const negativePatterns = [
    /(?:옳지|맞지|틀린|잘못된|부적절한|적절하지않은|타당하지않은|해당하지않는|아닌)것/,
    /(?:할|될|정할|적용할|인정할|허용할|구성할|포함할)수없는(?:것|사항|경우)?/,
    /(?:허용되지않는|금지되는|위반되는|배제되는|제외되는)것/,
    /(?:불가능한|허용되지않는)사항/
  ];
  if (negativePatterns.some(pattern => pattern.test(q))) return "negative";

  const positivePatterns = [
    /(?:옳은|맞는|타당한|적절한|해당하는)것/,
    /(?:할|될|정할|적용할|인정할|허용할|구성할|포함할)수있는(?:것|사항|경우)?/
  ];
  if (positivePatterns.some(pattern => pattern.test(q))) return "positive";
  return "direct";
}

function normalizeLawCitationText(value) {
  return String(value ?? "").replace(/\s+/g, "").replace(/[“”‘’]/g, "");
}

function normalizeEvidenceText(value) {
  return String(value ?? "").replace(/[^가-힣a-zA-Z0-9]/g, "");
}

function getTextSimilarity(a, b) {
  if (!a || !b) return 0;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (!longer.length) return 1;
  const maxDistance = Math.floor(longer.length * 0.15);
  if (longer.length - shorter.length > maxDistance) return 0;

  let previous = Array.from({ length: shorter.length + 1 }, (_, i) => i <= maxDistance ? i : Infinity);
  for (let i = 1; i <= longer.length; i++) {
    const current = Array(shorter.length + 1).fill(Infinity);
    if (i <= maxDistance) current[0] = i;
    const from = Math.max(1, i - maxDistance);
    const to = Math.min(shorter.length, i + maxDistance);
    let rowMin = Infinity;
    for (let j = from; j <= to; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (longer[i - 1] === shorter[j - 1] ? 0 : 1)
      );
      if (current[j] < rowMin) rowMin = current[j];
    }
    if (rowMin > maxDistance) return 0;
    previous = current;
  }
  const distance = previous[shorter.length];
  return distance <= maxDistance ? (longer.length - distance) / longer.length : 0;
}

function getBestEvidenceSimilarity(quote, source) {
  const q = normalizeEvidenceText(quote);
  if (!q || q.length < 4) return 0;
  const normalizedSource = normalizeEvidenceText(source);
  if (normalizedSource.includes(q)) return 1;

  const segments = String(source ?? "")
    .split(/[\r\n.!?。；;]+/)
    .map(normalizeEvidenceText)
    .filter(Boolean);
  const candidates = [...segments];
  for (let i = 0; i < segments.length - 1; i++) candidates.push(segments[i] + segments[i + 1]);

  let best = 0;
  for (const candidate of candidates) {
    if (candidate.includes(q)) return 1;
    const sim = getTextSimilarity(q, candidate);
    if (sim > best) best = sim;
    if (best >= 0.65) return best;
  }
  return best;
}

function buildLawSourceMap(article, refContent) {
  const sources = new Map();
  const add = (lawName, articleNum, content) => {
    const lawKey = normalizeLawCitationText(lawName);
    const articleKey = normalizeLawCitationText(articleNum);
    if (!lawKey || !/^제\d+조(?:의\d+)?$/.test(articleKey)) return;
    if (!sources.has(lawKey)) sources.set(lawKey, new Map());
    const articles = sources.get(lawKey);
    const existing = articles.get(articleKey) || "";
    const mergedLines = [...new Set(`${existing}\n${String(content ?? "")}`.split(/\r?\n/).filter(Boolean))];
    articles.set(articleKey, mergedLines.join("\n"));
  };

  add(article?.lawName, article?.num, article?.content);
  const blocks = String(refContent ?? "").matchAll(
    /^\[([^\]\r\n]+)\][ \t]*\r?\n([\s\S]*?)(?=^\[[^\]\r\n]+\][ \t]*$|(?![\s\S]))/gm
  );
  for (const block of blocks) {
    const header = block[1].split("→").pop().trim();
    const match = header.match(/^(.*?)(제\s*\d+\s*조(?:\s*의\s*\d+)?)$/);
    if (match) add(match[1].trim(), match[2], block[2]);
  }
  return sources;
}

function parseCitationSuffix(suffix) {
  const compact = String(suffix ?? "").replace(/\s+/g, "");
  const tokens = [];
  const tokenRegex = /제(\d+)항|제(\d+)호|([가-하])목|([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])항/g;
  let match;
  let lastIndex = 0;
  while ((match = tokenRegex.exec(compact))) {
    if (match.index !== lastIndex) break;
    if (match[1]) tokens.push({ type: "hang", value: Number(match[1]) });
    else if (match[2]) tokens.push({ type: "ho", value: Number(match[2]) });
    else if (match[3]) tokens.push({ type: "mok", value: match[3] });
    else if (match[4]) tokens.push({ type: "hang", value: match[4].charCodeAt(0) - 0x2460 + 1 });
    lastIndex = tokenRegex.lastIndex;
  }
  return { tokens, consumed: lastIndex, compact };
}

function validateCitationHierarchy(articleContent, citation) {
  const tokens = citation.tokens;
  if (!tokens.length) return { valid: true };

  // 법령 인용의 계층 순서는 조 -> 항 -> 호 -> 목이어야 한다.
  const order = { hang: 1, ho: 2, mok: 3 };
  for (let i = 1; i < tokens.length; i++) {
    if (order[tokens[i].type] <= order[tokens[i - 1].type]) {
      return { valid: false, reason: "항·호·목의 인용 순서가 법령 구조와 다릅니다." };
    }
  }
  if (tokens.filter(x => x.type === "hang").length > 1 ||
      tokens.filter(x => x.type === "ho").length > 1 ||
      tokens.filter(x => x.type === "mok").length > 1) {
    return { valid: false, reason: "같은 단계의 항·호·목이 중복 인용되었습니다." };
  }

  const lines = String(articleContent ?? "").split(/\r?\n/);
  const hangSet = new Set();
  const hoSet = new Set();
  const mokSet = new Set();
  let activeHang = null;
  let activeHo = null;

  for (const line of lines) {
    let m = line.match(/^\s*제(\d+)항(?!\s*제\d+호)(?:\s|$)/);
    if (m) {
      activeHang = Number(m[1]);
      activeHo = null;
      hangSet.add(activeHang);
      continue;
    }
    m = line.match(/^\s*(?:제(\d+)항\s*)?제?(\d+)호(?:\s|$)/);
    if (m) {
      const parentHang = m[1] ? Number(m[1]) : activeHang;
      const ho = Number(m[2]);
      activeHang = parentHang;
      activeHo = ho;
      hoSet.add(`${parentHang ?? "_"}:${ho}`);
      continue;
    }
    m = line.match(/^\s*([가-하])목(?:\s|$)/);
    if (m && activeHo != null) mokSet.add(`${activeHang ?? "_"}:${activeHo}:${m[1]}`);
  }

  const hang = tokens.find(x => x.type === "hang")?.value;
  const ho = tokens.find(x => x.type === "ho")?.value;
  const mok = tokens.find(x => x.type === "mok")?.value;
  if (hang != null && !hangSet.has(hang)) {
    return { valid: false, reason: `원문에 제${hang}항이 존재하지 않습니다.` };
  }
  if (ho != null && !hoSet.has(`${hang ?? "_"}:${ho}`) && !hoSet.has(`_:${ho}`)) {
    return { valid: false, reason: `원문에 ${hang != null ? `제${hang}항 ` : ""}제${ho}호가 존재하지 않습니다.` };
  }
  if (mok != null && !mokSet.has(`${hang ?? "_"}:${ho}:${mok}`) && !mokSet.has(`_:${ho}:${mok}`)) {
    return { valid: false, reason: `원문에 ${mok}목이 해당 호의 하위 항목으로 존재하지 않습니다.` };
  }
  return { valid: true };
}

function extractLawCitations(text, sources, primaryLawName) {
  const citations = [];
  const occupied = [];
  const lawNames = [...sources.keys()].sort((a, b) => b.length - a.length);

  for (const lawKey of lawNames) {
    const flexibleName = lawKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split("").join("\\s*");
    const suffixPattern = `((?:\\s*(?:제\\s*\\d+\\s*항|제\\s*\\d+\\s*호|[가-하]\\s*목|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\\s*항))*)`;
    const regex = new RegExp(`${flexibleName}\\s*(제\\s*\\d+\\s*조(?:\\s*의\\s*\\d+)?)(?:${suffixPattern})`, "g");
    let match;
    while ((match = regex.exec(text))) {
      const articleNum = normalizeLawCitationText(match[1]);
      const suffixInfo = parseCitationSuffix(match[2] || "");
      citations.push({
        lawKey,
        articleNum,
        tokens: suffixInfo.tokens,
        raw: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
      occupied.push([match.index, match.index + match[0].length]);
    }
  }

  const bareRegex = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?((?:\s*(?:제\s*\d+\s*항|제\s*\d+\s*호|[가-하]\s*목|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*항))*)/g;
  let match;
  while ((match = bareRegex.exec(text))) {
    const start = match.index;
    if (occupied.some(([a, b]) => start >= a && start < b)) continue;
    const suffixInfo = parseCitationSuffix(match[3] || "");
    citations.push({
      lawKey: normalizeLawCitationText(primaryLawName),
      articleNum: `제${match[1]}조${match[2] ? `의${match[2]}` : ""}`,
      tokens: suffixInfo.tokens,
      raw: match[0],
      start,
      end: match.index + match[0].length
    });
  }
  return citations;
}

function validateLawArticleCitations(quiz, article, refContent, auditResult = null) {
  const sources = buildLawSourceMap(article, refContent);
  const primaryLawKey = normalizeLawCitationText(article?.lawName);
  const texts = [
    quiz?.question,
    quiz?.answer,
    quiz?.explanation_answer,
    quiz?.explanation?.string,
    ...(Array.isArray(quiz?.options) ? quiz.options.map(option => option?.text) : [])
  ].filter(value => typeof value === "string");

  const citations = texts.flatMap(text => extractLawCitations(text, sources, primaryLawKey));
  for (const citation of citations) {
    const lawArticles = sources.get(citation.lawKey);
    const sourceContent = lawArticles?.get(citation.articleNum);
    if (!sourceContent) {
      return {
        valid: false,
        reason: `제공된 법령 원문에서 확인되지 않는 인용입니다: ${citation.lawKey} ${citation.articleNum}`
      };
    }
    const hierarchy = validateCitationHierarchy(sourceContent, citation);
    if (!hierarchy.valid) {
      return {
        valid: false,
        reason: `${citation.lawKey} ${citation.articleNum} ${citation.raw}: ${hierarchy.reason}`
      };
    }
  }

  // 감사 모델의 인용 근거가 실제로 해당 인용 조문의 본문을 뒷받침하는지 확인한다.
  if (auditResult && citations.length) {
    const claimEvidence = Array.isArray(auditResult.claim_evidence) ? auditResult.claim_evidence : [];
    for (const citation of citations) {
      const sourceContent = sources.get(citation.lawKey)?.get(citation.articleNum) || "";
      const related = claimEvidence.filter(item => {
        const claimText = `${item?.claim ?? ""} ${item?.reasoning ?? ""}`;
        const compactClaim = normalizeLawCitationText(claimText);
        return compactClaim.includes(citation.articleNum) ||
          compactClaim.includes(`${citation.lawKey}${citation.articleNum}`);
      });
      const supported = related.length > 0 && related.some(item =>
        getBestEvidenceSimilarity(item?.evidence_quote, sourceContent) >= 0.66
      );
      if (!supported) {
        return {
          valid: false,
          reason: `${citation.lawKey} ${citation.articleNum} 인용을 뒷받침하는 직접 근거가 해당 조문 원문에서 확인되지 않습니다. 참조 자료에 조문이 존재한다는 사실만으로는 인용을 인정하지 않습니다.`
        };
      }
    }
  }

  return { valid: true };
}

// ============================================================================
// 5. 퀴즈 서비스 및 검증 파이프라인 (Quiz AI Service)
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
      temperature: 0.05, 
      top_p: 1.0,
      reasoning_effort: reasoningEffort,
    });
    const content = response?.choices?.[0]?.message?.content;

    if (typeof content !== "string") return null;
    try {
      return JSON.parse(content);
    } catch (parseError) {
      throw parseError;
    }
  },

  async generateQuiz(article, retriesLeft = 2) {
    if (!article?.lawName || !article?.num || !article?.content || article.content.length < 30) return null;
    
    const isConstitution = article.lawName.includes("대한민국헌법") || article.lawId == "001444" ;
    const content = String(article.content || "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
    const refContent = String(article.referencedContent || "").trim();
    const userPrompt = PROMPTS.generate(article, content, refContent);
    const systemInstruction = !isConstitution
      ? `[SYSTEM 지침]\n퀴즈 출제가 불가능하면 아래 JSON 형태로 응답하라.\n{ "error": "[IDK]" }\n`
      : `[SYSTEM 지침]\n헌법 퀴즈는 반드시 완수하라.\n`;

    const finalPrompt = systemInstruction + userPrompt;

      try {
      await this.throttle();
      const requestOptions = {
        model: MODEL,
        responseFormat: { type: "json_object" },
        messages: [{ role: "user", content: finalPrompt }],
        temperature: 0.0,
        top_p: 1.0,
        reasoning_effort: "medium",
      };  

      /*if (!isConstitution) {
        requestOptions.stop = ["IDK"];
      }*/

      const response = await client.chat.complete(requestOptions);
      let contentRes = response?.choices?.[0]?.message?.content;
      if (typeof contentRes !== "string") return null;

      let rawQuiz;

try {
  rawQuiz = JSON.parse(
    contentRes
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim()
  );
} catch (parseError) {
  console.error("[Mistral] JSON 파싱 실패:", parseError.message);
  console.error("[Mistral 원본 content]:", contentRes);
  return null;
}
      if (!rawQuiz || rawQuiz.error) {
  console.error("[Mistral] 모델이 error 또는 빈 퀴즈 반환:", rawQuiz);
  return null;
}
      
      return Utils.normalizeQuiz(rawQuiz, article.num);
    } catch (err) {
  console.error(`[QuizService.generateQuiz] Mistral 호출/파싱 실패`, {
    message: err?.message,
    status: err?.statusCode ?? err?.status,
    response: err?.response?.data ?? err?.body ?? null,
    stack: err?.stack
  });
      if (Utils.isRateLimitError(err) && retriesLeft > 0) {
        await Utils.sleep(1350);
        return this.generateQuiz(article, retriesLeft - 1);
      }
      return null;
    }
  },

  validateRequiredFields(quiz) {
    if (!quiz || typeof quiz !== "object" || Array.isArray(quiz)) {
      return { valid: false, reason: "퀴즈 응답이 객체가 아님" };
    }
    for (const key of ["question", "answer"]) {
      if (typeof quiz[key] !== "string" || !quiz[key].trim()) {
        return { valid: false, reason: `필수 필드 누락 또는 빈 값: ${key}` };
      }
    }
    if (!quiz.explanation || typeof quiz.explanation.string !== "string" || !quiz.explanation.string.trim()) {
      return { valid: false, reason: "필수 필드 누락 또는 빈 값: explanation.string" };
    }
    if (quiz.explanation.Boolean !== true) {
      return { valid: false, reason: "explanation.Boolean이 true가 아님" };
    }
    if (!Array.isArray(quiz.options) || quiz.options.length !== 3) {
      return { valid: false, reason: `보기는 정확히 3개여야 함 (현재 ${quiz.options?.length ?? 0}개)` };
    }

    const correct = quiz.options.filter((o) => o.is_correct === true);
    if (correct.length !== 1) {
      return { valid: false, reason: `정답 표시는 정확히 하나여야 함 (현재 ${correct.length}개 - 복수 정답 불가)` };
    }
    if (correct[0].text.trim() !== quiz.answer.trim()) {
      return { valid: false, reason: "answer와 is_correct=true인 보기 텍스트가 불일치" };
    }
    if (quiz.calcError) return { valid: false, reason: String(quiz.calcError) };
    return { valid: true };
  },
  
  async auditQuiz(quiz, article, refContent) {
    const sourceText = String(article?.content || "").trim();
    if (!sourceText) return { valid: false, reason: "조문 원문 없음" };
    try {
      const result = await this.requestMistral(PROMPTS.audit(quiz, article, String(refContent || "").trim()), "xhigh");
      if (!result || typeof result !== "object") {
        return { valid: false, reason: "감사 응답 오류" };
      }
      
      const exlanation_contradiction = result.exlanation_contradiction === false || String(result.exlanation_contradiction || "").toLowerCase() === "false";
      const question_compatibility = result.question_compatibility === true || String(result.question_compatibility || "").toLowerCase() === "true";
      const verdict = String(result.verdict || "").toLowerCase();
      const pass = result.pass === true && verdict === "supported" && question_compatibility && exlanation_contradiction;

      if (!pass) {
        return { valid: false, reason: `근거 감사 실패 또는 해설 모순 발생 (exlanation_contradiction=${!exlanation_contradiction})` };
      }

      const options = Array.isArray(quiz.options) ? quiz.options : [];
      const correctIndex = options.findIndex(o => o?.is_correct === true);
      const assessments = result.option_assessments;

      if (!Array.isArray(assessments) || assessments.length !== 3) {
        return { valid: false, reason: "보기별 감사 결과 형식 오류" };
      }

      // 복수 정답 검증: matches_question이 true인 항목이 오직 1개인지 확인
      const matchingIndexes = assessments.filter(item => item.matches_question === true).map(item => Number(item.option_index));
      if (Number(result.selected_option_index) !== correctIndex || matchingIndexes.length !== 1 || matchingIndexes[0] !== correctIndex) {
        return { valid: false, reason: `복수 정답 또는 정답 매칭 오류 (유효 정답 수: ${matchingIndexes.length}개)` };
      }

      // 부정문·긍정문 질문은 보기의 진위와 정답 선택 방향도 대조한다.
const polarity = String(result.question_polarity || "").toLowerCase();
const detectedPolarity = detectQuestionPolarity(quiz.question);

if (!["negative", "positive", "direct"].includes(polarity)) {
  return {
    valid: false,
    reason: "감사 모델의 question_polarity 누락 또는 잘못된 값",
    audit: result
  };
}

if (polarity !== detectedPolarity) {
  return {
    valid: false,
    reason: `질문 문구와 감사 모델의 논리 방향 분류 불일치 (질문=${detectedPolarity}, 감사=${polarity})`,
    audit: result
  };
}
      

if (polarity === "negative" || polarity === "positive") {
  const expectedTruth = polarity === "negative" ? "false" : "true";

  const truthValue = value =>
    value === true || value === "true" ? "true" : "false";

  if (
    truthValue(assessments[correctIndex].statement_truth) !== expectedTruth ||
    assessments.some((item, index) =>
      item.matches_question &&
      truthValue(item.statement_truth) !== expectedTruth
    )
  ) {
    return {
      valid: false,
      reason: `질문 방향과 정답 보기의 진위 불일치 (polarity=${polarity})`,
      audit: result
    };
  }
}

      if (!Array.isArray(result.claim_evidence) || result.claim_evidence.length === 0 ||
          result.claim_evidence.some((x) => !x?.claim || !x?.evidence_quote || !x?.reasoning)) {
        return { valid: false, reason: "감사 응답에 주장-원문근거-추론 연결이 충분히 제시되지 않음", audit: result };
      }

      return { valid: true, reason: "원문 및 인용법령 감사 통과", audit: result };
    } catch (err) {
      return { valid: false, reason: `근거 감사 호출 실패: ${err.message}` };
    }
  },

  async fixQuiz(quiz, article, errorReason) {
    try {
      const raw = await this.requestMistral(PROMPTS.correction(quiz, article, errorReason), "xhigh");
      if (!raw || raw.error) return null;
      return Utils.normalizeQuiz(raw, article.num);
    } catch (err) {
      return null;
    }
  },

  async runValidationPipeline(initialQuiz, article, refContent) {
    let quiz = initialQuiz;
    const maxCorrections = 2;
    let lastReason = "";

    for (let pass = 0; pass <= maxCorrections; pass++) {
      const structure = this.validateRequiredFields(quiz);
      if (!structure.valid) {
        lastReason = `구조 검증: ${structure.reason}`;
      } else {
        const citationCheck = validateLawArticleCitations(quiz, article, refContent);

 if (!citationCheck.valid) {
   lastReason = `조문 번호 검증 실패: ${citationCheck.reason}`;
 } else {
   const audit = await this.auditQuiz(quiz, article, refContent);
   if (audit.valid) {
     const plaintextPkg = assembleQuizPlaintext(article, refContent, quiz);
     console.log(`[Plaintext 패키지 생성 완료 길이: ${plaintextPkg.length}자]`);
     return { valid: true, reason: audit.reason, quiz, audit: audit.audit, plaintext: plaintextPkg };
   }
   lastReason = audit.reason;
 }

      if (pass === maxCorrections) break;
      const corrected = await this.fixQuiz(quiz, article, lastReason);
      if (!corrected) return { valid: false, step: "rewrite", reason: lastReason, quiz };
      quiz = corrected;
    }

    return { valid: false, step: "audit", reason: lastReason, quiz };
  }
  },
  
  async generateValidQuizSlot(slotIndex, maxTries = 3) {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        const law = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
        const article = await LawService.fetchRandomArticle(law);
        if (!article) continue;

        const refContent = article.referencedContent ?? "";
        console.log(`[슬롯 ${slotIndex}] 퀴즈 생성 및 검증 시도 (${attempt}/${maxTries}) - 대상: ${law.lawName} ${article.num}`);

        const quiz = await this.generateQuiz(article);
        if (!quiz) {
        console.warn(`[슬롯 ${slotIndex}] 퀴즈 생성 실패`);
        continue;
      }
        const result = await this.runValidationPipeline(quiz, article, refContent);
        if (result.valid) {
          const { explanation_answer, calcError, ...clean } = result.quiz;
          return { ...clean, plaintextPackage: result.plaintext };
        }
      } catch (err) {
        console.error(`[슬롯 ${slotIndex}] 시도 (${attempt}/${maxTries}) 중 오류 발생:`, err);
      }
    }
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
    return res.status(500).json({ error: err.message, serverError: true, modelTierFlag: MODEL_TIER_FLAG });
  }
});

app.post("/api/lawquizzes/new", async (req, res) => {
  try {
    console.log("=== 병렬 퀴즈 세트 생성 및 근거 감사 시작 ===");
    const quizPromises = [1, 2, 3].map((index) => QuizService.generateValidQuizSlot(index));
    const results = await Promise.all(quizPromises);
    const newQuizzes = results.filter(Boolean);

    if (newQuizzes.length === 0) {
      return res.status(400).json({
        error: "퀴즈 생성 실패",
        message: "모든 시도가 실패했습니다.",
        serverError: true,
        modelTierFlag: MODEL_TIER_FLAG
      });
    }

    const quizSetId = String(Date.now());
    await db.collection("law_quizzes").doc(quizSetId).set({ createdAt: Date.now(), quizzes: newQuizzes });
    
    return res.json(newQuizzes);
  } catch (err) {
    return res.status(500).json({ error: "퀴즈 생성 오류", message: err?.message || "오류", serverError: true, modelTierFlag: MODEL_TIER_FLAG });
  }
});

app.use(express.static(path.join(__dirname, "..")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../index.html"));
});

export default app;
