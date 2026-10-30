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
const MODEL = 'ministral-8b-latest';
const MODEL_TIER_FLAG = { modelChanged: false, tier: 'ministral-8b-latest', serverError: false };
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
// 2. 유틸리티 (Utilities)
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

  normalizeLawNotation: function (text) {
    text = String(text ?? "");
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

  remapOptionRefs: (text, noMap) => {
    const CIRCLED = ["①", "②", "③"];
    const map = (n) => noMap.get(n) ?? n;
    return text
      .replace(/(?<!\d)([1-3])(\s*번)/g, (_, n, tail) => `${map(Number(n))}${tail}`)
      .replace(/([①②③])(\s*번)/g, (_, c, tail) => `${CIRCLED[map(CIRCLED.indexOf(c) + 1) - 1]}${tail}`)
      .replace(/((?:보기|선택지)\s*)([1-3])(?!\d|\s*번|\s*번의)/g, (_, head, n) => `${head}${map(Number(n))}`);
  },
  
  extractDate: function (text) {
    if (!text) return null;
    const match = text.match(/(\d{4}년\s*\d{1,2}월\s*\d{1,2}일|\d{4}[-./]\d{1,2}[-./]\d{1,2})/);
    return match ? match[0] : null;
  },

  normalizeQuiz: function (quiz) {
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
          string: fixGrammarAndTimeline(this.normalizeLawNotation(this.normalizeText(rawExpl.string ?? rawExpl.text ?? ""))),
          Boolean: typeof boolVal === "boolean" ? boolVal : String(boolVal).toLowerCase() === "true"
        };
      }
      return { string: fixGrammarAndTimeline(this.normalizeLawNotation(this.normalizeText(rawExpl))) , Boolean: true };
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
      const conflictsWithExplanationAnswer = expMatches.length === 1 && expMatches[0] !== targetIndex;
      const conflictsWithAnswer = ansMatches.length === 1 && ansMatches[0] !== targetIndex;

      if (conflictsWithExplanationAnswer || conflictsWithAnswer) {
        explanation.Boolean = false;
        console.warn("[normalizeQuiz] 정답 플래그와 answer/explanation_answer가 충돌합니다.");
      }
    } else {
      const expIndex = expMatches.length === 1 ? expMatches[0] : -1;
      const ansIndex = ansMatches.length === 1 ? ansMatches[0] : -1;

      if (expIndex !== -1 && ansIndex !== -1 && expIndex !== ansIndex) {
        explanation.Boolean = false;
        console.warn("[normalizeQuiz] explanation_answer와 answer가 충돌합니다.");
      } else if (expIndex !== -1) {
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

          if (scored[0]?.score >= 0.7 && (!scored[1] || scored[0].score - scored[1].score >= 0.08)) {
            targetIndex = scored[0].index;
          } else if (scored[0]?.score >= 0.7) {
            explanation.Boolean = false;
            console.warn("[normalizeQuiz] 정답 후보가 모호합니다.");
          }
        }
      }
    }

    const options = rawOptions.map((opt, idx) => ({
      ...opt,
      is_correct: idx === targetIndex
    }));

    const normalized = {
      ...quiz,
      id: this.normalizeText(quiz.id),
      category: this.normalizeText(quiz.category),
      explanation,
      question: fixGrammarAndTimeline(this.normalizeText(quiz.question)),
      answer: targetIndex !== -1 ? rawOptions[targetIndex].text : fixGrammarAndTimeline(this.normalizeText(quiz.answer)),
      timer_sec: Number(quiz.timer_sec) || 15,
      options: options.map(opt => ({ ...opt, text: fixGrammarAndTimeline(opt.text) })),
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
// 4. 프롬프트 정의 (Prompts)
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
***출제자는 날짜 및 숫자 계산에 신중해야 하며, 항상 최선을 다해야 한다.***

법령명: ${article.lawName}
조문번호: ${article.num}
[출제 조문 내용]
${content}

${refContent ? `[참조 및 인용 조문 내용]\n${refContent}\n` : ""}
위 조문의 내용과 참조 및 인용 조문 내용을 모두 읽고 실제 법률 지식을 테스트할 수 있는 퀴즈를 작성하세요. **모르면 반드시 [IDK] 특수 토큰을 넣으세요. 단, 헌법 범위는 제외합니다.**
**추측이나 개인적 견해를 절대로 포함하지 마십시오.** 반드시 순수 JSON만 출력하세요.

### [한국어 문장 품질 규칙 - 필수]
1. 문제·보기·정답·해설은 자연스럽고 정확한 현대 한국어로 작성한다.
2. 질문은 쟁점 하나를 간결하게 묻고, 보기와 직접 연결되게 작성한다.
3. 법률상 권리·권한·절차와 주체, 객체, 권리자, 의무자를 서로 바꾸어 쓰지 않는다.
4. 보기 세 개는 각각 독립된 한 문장으로 작성한다.
5. 세 보기의 문장 구조와 종결 형식을 통일한다.
6. 예외, 단서, 요건, 조건이 있다면 절대로 생략하거나 혼동하지 않는다.
7. 해설은 3단계 단문 구조([결론], [법령 근거], [사안 대입])로만 작성한다. 질문에 사례와 가명이 없다면 [사안 대입]은 완전히 생략해야만 한다.

### [일반 사실 추론 및 법령 외 일반 사실 검증 프로토콜]
- 법령에 직접 적혀 있지 않은 일반 사실은 모델의 일반 지식, 사회적 맥락, 일상적 인과관계를 활용하되 무리한 추측을 배제한다.
- **법령 외 일반 사실이 전혀 포함되지 않은 경우 검증을 즉시 통과(Pass)시킨다.**

출력 형식:
{
  "id": "quiz-${Date.now()}",
  "category": "${article.lawName}",
  "concept_summary": "[문제 푸는 목표 및 의도, 문제 요약]",
  "calcul_check": null,
  "judicial_precedent": null, 
  "explanation": {"string": "[상세 해설]", "Boolean": true},
  "question": "[질문]", 
  "explanation_answer": "[해설과 일치하는 정답 텍스트]",
  "options": [
   ${randomOptionsTemplate()}
  ],
  "answer": "[정답 텍스트]",
  "timer_sec": 15
}`,

  audit: (quiz, article, refContent) => `
너는 생성된 법률 퀴즈의 근거와 추론을 감사하는 검토자다. 아래 제공된 원문 및 인용법령을 근거로 퀴즈의 핵심 주장과 결론이 실제 뒷받침되는지 검토하라.
또한 법령에 없는 일반 사실이 포함되어 있다면 그 타당성을 검증하되, 일반 사실이 없으면 통과(Pass)시키라.

[출제 대상 법령]
${article.lawName} ${article.num}
[출제 조문 원문]
${article.content}
[참조 및 위임 조문 원문]
${refContent || "제공된 참조 조문 없음"}
[생성된 퀴즈]
${JSON.stringify(quiz, null, 2)}

반드시 순수 JSON만 출력한다.
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
  }`,

  correction: (quiz, article, errorReason) => `
당신은 대한민국 법률 퀴즈 출제자입니다. 다음 퀴즈는 검토 과정에서 문제가 발견되었습니다. 아래 오류 사유를 반영하여 수정하십시오.
[원문 조문]
${article.content}
${article.referencedContent ? `\n[참조 조문]\n${article.referencedContent}` : ''}
[오류 사유]
${errorReason}
[기존 퀴즈 데이터]
${JSON.stringify(quiz, null, 2)}
기존과 동일한 순수 JSON 형식으로만 출력하십시오.
`
};

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
      top_p: 0.0,
      reasoning_effort: reasoningEffort,
    });
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return JSON.parse(content);
  },

  async generateQuiz(article, retriesLeft = 2) {
    if (!article?.lawName || !article?.num || !article?.content || article.content.length < 30) return null;
    
    const isConstitution = article.lawName.includes("대한민국헌법") || article.lawId == "001444" || article.lawId == "61603";
    const content = String(article.content || "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
    const refContent = String(article.referencedContent || "").trim();
    const userPrompt = PROMPTS.generate(article, content, refContent);

    const systemInstruction = !isConstitution
      ? `[SYSTEM 지침]\n퀴즈 출제가 불가능하면 아래 JSON 형태로 응답하라.\n{ "error": "[IDK]" }\n`
      : `[SYSTEM 지침]\n헌법 퀴즈는 반드시 완성하라.\n`;

    const finalPrompt = systemInstruction + userPrompt;

    try {
      await this.throttle();
      const requestOptions = {
        model: MODEL,
        responseFormat: { type: "json_object" },
        messages: [{ role: "user", content: finalPrompt }],
        temperature: 0.0,
        top_p: 0.0,
        reasoning_effort: "high",
      };  

      if (!isConstitution) {
        requestOptions.stop = ["[IDK]"];
      }

      const response = await client.chat.complete(requestOptions);
      let contentRes = response?.choices?.[0]?.message?.content;
      if (typeof contentRes !== "string") return null;

      let rawQuiz = null;
      try {
        const sanitized = contentRes.replace(/^\s*```json\s*/i, "").replace(/^\s*```\s*/i, "").replace(/\s*```\s*$/i, "").trim();
        rawQuiz = JSON.parse(sanitized);
      } catch (error) {
        if (isConstitution && retriesLeft > 0) {
          await Utils.sleep(1000);
          return this.generateQuiz(article, retriesLeft - 1);
        }
        return null; 
      }
      
      const isEmptyQuiz = !rawQuiz || Object.keys(rawQuiz).length === 0;
      const isErrorResponse = rawQuiz && (rawQuiz.error || rawQuiz.message || !rawQuiz.question);
      
      if ((isEmptyQuiz || isErrorResponse) && !isConstitution) return null;
      if ((isEmptyQuiz || isErrorResponse) && isConstitution) {
        if (retriesLeft > 0) {
          await Utils.sleep(1000);
          return this.generateQuiz(article, retriesLeft - 1);
        }
        return null;
      }
      
      const quizString = JSON.stringify(rawQuiz);
      if (!isConstitution && quizString && quizString.includes("[IDK]")) return null;

      return Utils.normalizeQuiz(rawQuiz);
    } catch (err) {
      if (Utils.isRateLimitError(err) && retriesLeft > 0) {
        await Utils.sleep(1350);
        return this.generateQuiz(article, retriesLeft - 1);
      }
      return null;
    }
  },

  validateRequiredFields(quiz) {
    if (!quiz || typeof quiz !== "object" || Array.isArray(quiz)) return { valid: false, reason: "퀴즈 응답이 객체가 아님" };
    for (const key of ["question", "answer"]) {
      if (typeof quiz[key] !== "string" || !quiz[key].trim()) return { valid: false, reason: `필수 필드 누락: ${key}` };
    }
    if (!quiz.explanation || typeof quiz.explanation.string !== "string" || !quiz.explanation.string.trim()) {
      return { valid: false, reason: "필수 필드 누락: explanation.string" };
    }
    if (!Array.isArray(quiz.options) || quiz.options.length !== 3) {
      return { valid: false, reason: "보기는 정확히 3개여야 함" };
    }
    return { valid: true };
  },
  
  async auditQuiz(quiz, article, refContent) {
    const sourceText = String(article?.content || "").trim();
    if (!sourceText) return { valid: false, reason: "조문 원문 없음" };
    try {
      const result = await this.requestMistral(PROMPTS.audit(quiz, article, String(refContent || "").trim()), "xhigh");
      if (!result || typeof result !== "object" || Array.isArray(result)) return { valid: false, reason: "감사 응답 오류" };
      
      const pass = result.pass === true && String(result.verdict || "").toLowerCase() === "supported";
      if (!pass) return { valid: false, reason: result.summary || "근거 감사 실패", audit: result };

      return { valid: true, reason: "원문 및 인용법령 감사 통과", audit: result };
    } catch (err) {
      return { valid: false, reason: `근거 감사 호출 실패: ${err.message}` };
    }
  },

  async fixQuiz(quiz, article, errorReason) {
    try {
      const raw = await this.requestMistral(PROMPTS.correction(quiz, article, errorReason), "xhigh");
      if (!raw || raw.error === "[IDK]" || raw.error) return null;
      return Utils.normalizeQuiz(raw);
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
        const audit = await this.auditQuiz(quiz, article, refContent);
        if (audit.valid) {
          // 요구사항 1 반영: Plaintext 통합 패키지 생성 검증 로그 출력
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
  },

  async generateValidQuizSlot(slotIndex, maxTries = 3) {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const law = VALID_LAW_IDS[Math.floor(Math.random() * VALID_LAW_IDS.length)];
      const article = await LawService.fetchRandomArticle(law);
      if (!article) continue;

      const refContent = article.referencedContent ?? "";
      const quiz = await this.generateQuiz(article);
      if (!quiz) continue;

      const result = await this.runValidationPipeline(quiz, article, refContent);
      if (result.valid) {
        const { explanation_answer, calcError, ...clean } = result.quiz;
        return { ...clean, plaintextPackage: result.plaintext };
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
      return res.status(400).json({ error: "퀴즈 생성 실패", message: "모든 시도가 실패했습니다.", serverError: true, modelTierFlag: MODEL_TIER_FLAG });
    }

    const quizSetId = String(Date.now());
    await db.collection("law_quizzes").doc(quizSetId).set({ createdAt: Date.now(), quizzes: newQuizzes });
    
    return res.json(newQuizzes);
  } catch (err) {
    return res.status(500).json({ error: "퀴즈 생성 오류", message: err?.message || "오류", serverError: true, modelTierFlag: MODEL_TIER_FLAG });
  }
});

app.get("/api/mistral-models", async (req, res) => {
  try {
    const response = await axios.get("[https://api.mistral.ai/v1/models](https://api.mistral.ai/v1/models)", {
      headers: { Authorization: `Bearer ${process.env.LAW_QUIZ_MISTRAL_KEY}` },
      timeout: 10000,
    });
    const models = Array.isArray(response.data?.data) ? response.data.data.map(model => model.id).filter(Boolean) : [];
    return res.json({ models, modelTierFlag: MODEL_TIER_FLAG });
  } catch (err) {
    return res.status(err?.response?.status || 500).json({ error: "모델 목록 조회 실패", serverError: true, modelTierFlag: MODEL_TIER_FLAG });
  }
});

app.get("/api/debug/lawname/:mst", (req, res) => {
  res.json({ url: req.url, params: req.params, query: req.query });
});

app.get("/api/debug-byl", async (req, res) => {
  const mst = req.query.mst;
  if (!mst) return res.status(400).type("text/plain").send("mst 쿼리 필요");

  const data = await lawGet(LAW_API_URL, { target: "law", MST: mst });
  const list = toArr(data?.["법령"]?.["별표"]?.["별표단위"]);

  if (!list.length) {
    return res.type("text/plain").send("별표 없음\n" + JSON.stringify(data).slice(0, 500));
  }

  res.type("text/plain").send(
    list.map((b) => {
      const no = Number(b["별표번호"] || 0);
      const sub = Number(b["별표가지번호"] || 0);
      const tag = sub > 0 ? `별표 ${no}의${sub}` : `별표 ${no}`;
      return `[${tag}]\n${dec(bylText(b))}`;
    }).join("\n\n")
  );
});

app.use(express.static(path.join(__dirname, "..")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../index.html"));
});

export default app;
