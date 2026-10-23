
import fs from "node:fs/promises";
import path from "node:path";
import { openAsBlob } from "node:fs";

async function loadDotEnv() {
  try {
    const content = await fs.readFile(path.resolve(process.cwd(), ".env"), "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;

      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }

      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

await loadDotEnv();

const API_BASE = "https://api.mistral.ai/v1";
const API_KEY =
  process.env.LAW_QUIZ_MISTRAL_KEY || process.env.MISTRAL_API_KEY;
const BASE_MODEL =
  process.env.FINETUNE_BASE_MODEL || "ministral-8b-latest";
const TRAINING_STEPS = Number(
  process.env.FINETUNE_TRAINING_STEPS || 100
);
const LEARNING_RATE = Number(
  process.env.FINETUNE_LEARNING_RATE || 0.0001
);

function assertApiKey() {
  if (!API_KEY) {
    throw new Error(
      "LAW_QUIZ_MISTRAL_KEY 또는 MISTRAL_API_KEY를 .env에 설정하세요."
    );
  }
}

async function api(pathname, { method = "GET", body, headers = {} } = {}) {
  assertApiKey();

  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...headers,
    },
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });

  const responseText = await response.text();
  let data;

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = { raw: responseText };
  }

  if (!response.ok) {
    const detail =
      data?.message ||
      data?.detail ||
      data?.error ||
      responseText ||
      response.statusText;

    throw new Error(
      `Mistral API ${response.status}: ${
        typeof detail === "string" ? detail : JSON.stringify(detail)
      }`
    );
  }

  return data;
}

// Only explicitly reviewed examples may be used for fine-tuning.
function isApprovedForTraining(example) {
  return example?.trainingApproved === true;
}

function validateQuiz(example, index) {
  const prefix = `examples[${index}]`;
  const q = example?.quiz;

  if (!example || typeof example !== "object") {
    throw new Error(`${prefix}: 객체여야 합니다.`);
  }

  // 법령 원문 필수 항목
  for (const key of ["lawName", "articleNum", "lawText"]) {
    if (typeof example[key] !== "string" || !example[key].trim()) {
      throw new Error(`${prefix}.${key}가 비어 있습니다.`);
    }
  }

  if (!q || typeof q !== "object") {
    throw new Error(`${prefix}.quiz 객체가 없습니다.`);
  }

  if (typeof q.question !== "string" || !q.question.trim()) {
    throw new Error(`${prefix}.quiz.question 누락`);
  }

  if (typeof q.answer !== "string" || !q.answer.trim()) {
    throw new Error(`${prefix}.quiz.answer 누락`);
  }

  if (
    typeof q.explanation?.string !== "string" ||
    !q.explanation.string.trim()
  ) {
    throw new Error(`${prefix}.quiz.explanation.string 누락`);
  }

  if (q.explanation?.Boolean !== true) {
    throw new Error(
      `${prefix}: explanation.Boolean이 true인 문제만 학습할 수 있습니다.`
    );
  }

  if (!Array.isArray(q.options) || q.options.length !== 4) {
    throw new Error(`${prefix}: 보기는 정확히 4개여야 합니다.`);
  }

  const correct = q.options.filter(
    (option) => option?.is_correct === true
  );

  if (correct.length !== 1) {
    throw new Error(
      `${prefix}: is_correct=true인 보기는 정확히 1개여야 합니다.`
    );
  }

  if (correct[0].text?.trim() !== q.answer.trim()) {
    throw new Error(
      `${prefix}: answer와 정답 보기 text가 일치하지 않습니다.`
    );
  }

  if (JSON.stringify(q).includes("[IDK]")) {
    throw new Error(
      `${prefix}: [IDK]가 포함된 문제는 학습할 수 없습니다.`
    );
  }
}

function buildPrompt(example) {
  // 실제 서비스에서 사용한 프롬프트가 있으면 그대로 사용
  if (typeof example.prompt === "string" && example.prompt.trim()) {
    return example.prompt;
  }

  return `너는 대한민국 법률 객관식 퀴즈 생성기다.
제공된 법령 본문에 근거하여 4지선다 문제를 작성하라.
제공되지 않은 판례나 법리를 추측해서 만들지 마라.
근거가 부족하면 {"error":"[IDK]"}만 출력하라.
보기는 정확히 4개이며 정답은 정확히 1개여야 한다.
answer는 정답 보기의 text와 완전히 일치해야 한다.
설명의 Boolean은 검증이 완료된 경우에만 true로 설정하라.
결과는 순수 JSON으로 출력하라.

[법령명]
${example.lawName}

[조문번호]
${example.articleNum}

[출제 조문 내용]
${example.lawText}

${
  example.referencedText
    ? `[참조 조문 내용]\n${example.referencedText}\n`
    : ""
}

출력 키:
id, category, concept_summary, calcul_check,
judicial_precedent, question, explanation,
explanation_answer, options, answer, timer_sec`;
}

function buildTargetQuiz(quiz) {
  const target = structuredClone(quiz);

  // 학습 데이터의 고정 ID를 실제 서비스에서 재사용하지 않도록 설정
  target.id = "quiz-TRAINING-ID";
  target.explanation_answer =
    target.explanation_answer || target.answer;

  delete target.calcError;

  return target;
}

async function prepareDataset(
  inputPath,
  trainPath,
  validPath
) {
  const parsed = JSON.parse(
    await fs.readFile(inputPath, "utf8")
  );

  if (!Array.isArray(parsed)) {
    throw new Error(
      "입력 JSON의 최상위 값은 예시 객체 배열이어야 합니다."
    );
  }

  // 명시적으로 승인되고 기본 검증을 통과한 예시만 학습 대상으로 선택
  const approved = parsed.filter(isApprovedForTraining);

  if (approved.length < 2) {
    throw new Error(
      `trainingApproved: true인 승인 문제가 최소 2개 필요합니다. 현재 ${approved.length}개입니다.`
    );
  }

  // 승인된 문제의 형식과 정답을 검증
  approved.forEach(validateQuiz);

  // 재현 가능한 무작위 분할
  let seed = 20261023;

  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const rows = approved.map((example) => ({
    messages: [
      {
        role: "user",
        content: buildPrompt(example),
      },
      {
        role: "assistant",
        content: JSON.stringify(
          buildTargetQuiz(example.quiz)
        ),
      },
    ],
  }));

  // Fisher-Yates 셔플
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }

  const validationCount =
    approved.length >= 10
      ? Math.max(1, Math.floor(approved.length * 0.1))
      : 1;

  const validRows = rows.slice(0, validationCount);
  const trainRows = rows.slice(validationCount);

  await fs.writeFile(
    trainPath,
    trainRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8"
  );

  await fs.writeFile(
    validPath,
    validRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8"
  );

  console.log(
    `학습 데이터 생성: ${trainPath} (${trainRows.length}개)`
  );

  console.log(
    `검증 데이터 생성: ${validPath} (${validRows.length}개)`
  );

  if (approved.length < 50) {
    console.warn(
      "경고: 승인된 학습 데이터가 50개 미만입니다."
    );
  }

  console.log(
    `전체 입력 ${parsed.length}개 중 승인된 문제 ${approved.length}개 사용`
  );
}

async function uploadJsonl(filePath) {
  const stat = await fs.stat(filePath);

  if (!stat.isFile()) {
    throw new Error(`파일이 아닙니다: ${filePath}`);
  }

  if (!filePath.toLowerCase().endsWith(".jsonl")) {
    throw new Error(
      "업로드 파일은 .jsonl 형식이어야 합니다."
    );
  }

  const form = new FormData();

  form.append("purpose", "fine-tune");
  form.append(
    "file",
    await openAsBlob(filePath),
    path.basename(filePath)
  );

  const uploaded = await api("/files", {
    method: "POST",
    body: form,
  });

  if (!uploaded?.id) {
    throw new Error(
      `파일 업로드 응답에 id가 없습니다: ${JSON.stringify(uploaded)}`
    );
  }

  console.log(
    `업로드 완료: ${path.basename(filePath)} -> ${uploaded.id}`
  );

  return uploaded;
}

async function createJob(trainPath, validPath) {
  const trainingFile = await uploadJsonl(trainPath);

  const validationFile = validPath
    ? await uploadJsonl(validPath)
    : null;

  const payload = {
    model: BASE_MODEL,
    training_files: [
      {
        file_id: trainingFile.id,
        weight: 1,
      },
    ],
    hyperparameters: {
      training_steps: TRAINING_STEPS,
      learning_rate: LEARNING_RATE,
    },
    auto_start: true,
  };

  if (validationFile) {
    payload.validation_files = [validationFile.id];
  }

  const job = await api("/fine_tuning/jobs", {
    method: "POST",
    body: payload,
  });

  const jobId = job?.id || job?.job_id;

  console.log("파인튜닝 작업 생성 결과:");
  console.log(
    JSON.stringify(
      {
        id: jobId,
        status: job?.status,
        model: payload.model,
        trainingFile: trainingFile.id,
        validationFile: validationFile?.id || null,
      },
      null,
      2
    )
  );

  if (jobId) {
    console.log(
      `상태 확인 명령: node mistral-finetune.mjs status ${jobId}`
    );
  }

  return job;
}

async function showStatus(jobId) {
  if (!jobId) {
    throw new Error("job_id가 필요합니다.");
  }

  const job = await api(
    `/fine_tuning/jobs/${encodeURIComponent(jobId)}`
  );

  console.log(JSON.stringify(job, null, 2));

  const model =
    job?.fine_tuned_model || job?.fineTunedModel;

  if (model) {
    console.log(`파인튜닝 모델 ID: ${model}`);
    console.log(`환경 변수 설정: LAW_QUIZ_MODEL=${model}`);
  }

  return job;
}

async function waitForJob(jobId) {
  if (!jobId) {
    throw new Error("job_id가 필요합니다.");
  }

  const terminal = new Set([
    "SUCCESS",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
    "CANCELED",
  ]);

  while (true) {
    const job = await api(
      `/fine_tuning/jobs/${encodeURIComponent(jobId)}`
    );

    const status = String(
      job?.status || "UNKNOWN"
    ).toUpperCase();

    console.log(
      `[${new Date().toISOString()}] ${jobId}: ${status}`
    );

    if (terminal.has(status)) {
      console.log(JSON.stringify(job, null, 2));

      const model =
        job?.fine_tuned_model || job?.fineTunedModel;

      if (model) {
        console.log(`완료된 모델 ID: ${model}`);
        console.log(`환경 변수 설정: LAW_QUIZ_MODEL=${model}`);
      }

      if (
        status === "FAILED" ||
        status === "CANCELLED" ||
        status === "CANCELED"
      ) {
        process.exitCode = 1;
      }

      return;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 15000)
    );
  }
}

async function startJob(jobId) {
  if (!jobId) {
    throw new Error("job_id가 필요합니다.");
  }

  const result = await api(
    `/fine_tuning/jobs/${encodeURIComponent(jobId)}/start`,
    {
      method: "POST",
      body: {},
    }
  );

  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "prepare") {
    const [
      input,
      train = "training.jsonl",
      valid = "validation.jsonl",
    ] = args;

    if (!input) {
      throw new Error(
        "사용법: node mistral-finetune.mjs prepare examples.json [training.jsonl] [validation.jsonl]"
      );
    }

    return prepareDataset(input, train, valid);
  }

  if (command === "train") {
    const [
      train = "training.jsonl",
      valid = "validation.jsonl",
    ] = args;

    const validExists = await fs
      .access(valid)
      .then(() => true)
      .catch(() => false);

    return createJob(
      train,
      validExists ? valid : null
    );
  }

  if (command === "status") {
    return showStatus(args[0]);
  }

  if (command === "wait") {
    return waitForJob(args[0]);
  }

  if (command === "start-job") {
    return startJob(args[0]);
  }

  console.log(`Mistral 파인튜닝 도구

명령어:
  node mistral-finetune.mjs prepare examples.json
  node mistral-finetune.mjs train
  node mistral-finetune.mjs status <job_id>
  node mistral-finetune.mjs wait <job_id>
  node mistral-finetune.mjs start-job <job_id>

환경 변수:
  LAW_QUIZ_MISTRAL_KEY 또는 MISTRAL_API_KEY (필수)
  FINETUNE_BASE_MODEL=ministral-8b-latest
  FINETUNE_TRAINING_STEPS=100
  FINETUNE_LEARNING_RATE=0.0001`);
}

main().catch((error) => {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
});

