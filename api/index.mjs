async generateValidQuizSlot(slotIndex, maxTries = 3) {
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    console.log(`[슬롯 ${slotIndex}] 법령 조회 시작 (${attempt}/${maxTries})`);

    const law = VALID_LAW_IDS[
      Math.floor(Math.random() * VALID_LAW_IDS.length)
    ];

    const article = await LawService.fetchRandomArticle(law);

    console.log(
      `[슬롯 ${slotIndex}] 법령 조회 종료: ${article ? "성공" : "실패"}`
    );

    if (!article) continue;

    const refContent = article.referencedContent ?? "";

    if (!refContent && article.content.length < 37) {
      console.warn(`[슬롯 ${slotIndex}] 원문 부족, 건너뜀`);
      continue;
    }

    console.log(`[슬롯 ${slotIndex}] 퀴즈 생성 시작`);
    const quiz = await this.generateQuiz(article);
    console.log(`[슬롯 ${slotIndex}] 퀴즈 생성 종료`);

    if (!quiz) {
      console.warn(`[슬롯 ${slotIndex}] 퀴즈 생성 실패`);
      continue;
    }

    console.log(`[슬롯 ${slotIndex}] 검증 파이프라인 시작`);
    const result = await this.runValidationPipeline(
      quiz,
      article,
      refContent
    );
    console.log(`[슬롯 ${slotIndex}] 검증 파이프라인 종료`);

    if (result.valid) {
      console.log(`[슬롯 ${slotIndex}] 최종 검증 성공 (시도 ${attempt})`);
      const { explanation_answer, calcError, ...clean } = result.quiz;
      return clean;
    }
  }

  console.warn(`[슬롯 ${slotIndex}] 모든 생성 및 검증 시도 실패`);
  return null;
}
