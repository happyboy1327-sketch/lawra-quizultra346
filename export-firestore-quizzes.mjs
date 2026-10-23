import fs from "node:fs/promises";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
if (!rawKey) throw new Error("GitHub Actions Secret FIREBASE_SERVICE_ACCOUNT_KEY가 필요합니다.");

let serviceAccount;
try {
  serviceAccount = JSON.parse(rawKey);
  if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
} catch (error) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY JSON 파싱 실패: " + error.message);
}

const app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);
const snapshot = await db.collection("law_quizzes").get();
const examples = [];
let invalidCount = 0;
for (const doc of snapshot.docs) {
  const data = doc.data();
  const quizzes = Array.isArray(data.quizzes) ? data.quizzes :
    data.quizzes && typeof data.quizzes === "object" ? Object.values(data.quizzes) : [];
  for (const quiz of quizzes) {
    const correct = Array.isArray(quiz?.options)
      ? quiz.options.filter((option) => option?.is_correct === true)
      : [];
    const valid = quiz && typeof quiz === "object" &&
      typeof quiz.question === "string" && quiz.question.trim() &&
      typeof quiz.answer === "string" && quiz.answer.trim() &&
      typeof quiz.explanation?.string === "string" && quiz.explanation.string.trim() &&
      quiz.explanation?.Boolean === true &&
      Array.isArray(quiz.options) && quiz.options.length === 4 &&
      correct.length === 1 && correct[0].text?.trim() === quiz.answer.trim() &&
      !JSON.stringify(quiz).includes("[IDK]");
    if (!valid) { invalidCount++; continue; }
    // API는 3단계 검증을 통과한 퀴즈만 law_quizzes에 저장한다.
    examples.push({ trainingApproved: true, firestoreDocumentId: doc.id, createdAt: data.createdAt ?? null, quiz });
  }
}
if (examples.length < 2) throw new Error("학습 가능한 Firestore 퀴즈가 2개 미만입니다. 추출 " + examples.length + "개, 제외 " + invalidCount + "개.");
const output = process.argv[2] || "firestore-examples.json";
await fs.writeFile(output, JSON.stringify(examples, null, 2), "utf8");
console.log("Firestore law_quizzes: 문서 " + snapshot.size + "개에서 퀴즈 " + examples.length + "개 추출, 제외 " + invalidCount + "개");
console.log("출력 파일: " + output);
