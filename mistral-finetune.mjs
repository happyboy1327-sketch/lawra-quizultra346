function isApprovedForTraining(example) {
  // 명시적으로 제외한 데이터는 학습하지 않음
  if (example.trainingApproved === false) return false;

  // 검수 완료 표시가 없는 데이터도 학습하지 않음
  if (example.trainingApproved !== true) return false;

  const q = example.quiz;
  if (!q || q.explanation?.Boolean !== true) return false;
  if (!Array.isArray(q.options) || q.options.length !== 4) return false;

  const correct = q.options.filter(o => o?.is_correct === true);
  if (correct.length !== 1) return false;
  if (correct[0].text?.trim() !== q.answer?.trim()) return false;

  return true;
}
