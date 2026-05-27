export type RunMarketVolumes = {
  bnl: number;
  nordics: number;
  de: number;
};

export type RunCount = 1 | 2 | 3;

export type RunSplitPlan = {
  runCount: RunCount;
  firstRun: {
    bnl: number;
    nordics: number;
    de: number;
    total: number;
  };
  baseTotal: number;
  baseRemainder: number;
  upliftTotal: number;
  upliftPortions: number;
  secondRun: number;
  thirdRun: number;
};

// 1 run: ≤ 800 total portions (not worth splitting)
export const SINGLE_RUN_MAX = 800;
// 3 runs: > 4500 total portions (very large batches)
export const TRIPLE_RUN_MIN = 4500;

export const RUN_ONE_FACTORS = {
  bnl:     1.0,
  nordics: 1.0,
  de_2run: 0.7,   // 2-run: 70% DE in Run 1, 30% in Run 2
  de_3run: 0.35,  // 3-run: 35% DE per run
} as const;

export const SECOND_RUN_TOTAL_FACTOR = 1.1;

export function recommendedRunCount(totalBase: number): RunCount {
  if (totalBase <= SINGLE_RUN_MAX) return 1;
  if (totalBase >= TRIPLE_RUN_MIN) return 3;
  return 2;
}

function cleanPortions(value: number): number {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

export function calculateRunSplit(volumes: RunMarketVolumes): RunSplitPlan {
  const bnl     = cleanPortions(volumes.bnl);
  const nordics = cleanPortions(volumes.nordics);
  const de      = cleanPortions(volumes.de);
  const baseTotal   = bnl + nordics + de;
  const upliftTotal = Math.round(baseTotal * SECOND_RUN_TOTAL_FACTOR);
  const runCount    = recommendedRunCount(baseTotal);

  const deFactor = runCount === 3 ? RUN_ONE_FACTORS.de_3run : RUN_ONE_FACTORS.de_2run;

  const firstRun = {
    bnl:     Math.round(bnl     * RUN_ONE_FACTORS.bnl),
    nordics: Math.round(nordics * RUN_ONE_FACTORS.nordics),
    de:      Math.round(de      * deFactor),
  };
  const firstTotal = firstRun.bnl + firstRun.nordics + firstRun.de;

  let secondRun = 0;
  let thirdRun  = 0;

  if (runCount === 1) {
    secondRun = 0;
    thirdRun  = 0;
  } else if (runCount === 2) {
    secondRun = Math.max(0, upliftTotal - firstTotal);
    thirdRun  = 0;
  } else {
    // 3 runs: Run 2 covers second slice of DE, Run 3 gets remainder + uplift
    const run2De = Math.round(de * RUN_ONE_FACTORS.de_3run);
    secondRun = run2De;
    thirdRun  = Math.max(0, upliftTotal - firstTotal - secondRun);
  }

  return {
    runCount,
    firstRun: { ...firstRun, total: firstTotal },
    baseTotal,
    baseRemainder: Math.max(0, baseTotal - firstTotal),
    upliftTotal,
    upliftPortions: Math.max(0, upliftTotal - baseTotal),
    secondRun,
    thirdRun,
  };
}

export function runSplitForRecipeLike(recipe: {
  bnl?: number;
  nordics?: number;
  de?: number;
  verdenVolume?: { BENL?: number; DKSE?: number; DE?: number };
}): RunSplitPlan {
  return calculateRunSplit({
    bnl:     recipe.bnl     ?? recipe.verdenVolume?.BENL ?? 0,
    nordics: recipe.nordics ?? recipe.verdenVolume?.DKSE ?? 0,
    de:      recipe.de      ?? recipe.verdenVolume?.DE   ?? 0,
  });
}
