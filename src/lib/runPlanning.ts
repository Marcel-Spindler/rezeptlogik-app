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

export const RUN_ONE_FACTOR = 0.65; // Run 1 always gets 65% of base total
export const LAST_RUN_FACTOR = 0.10; // Last run (Run 3) always gets 10% of uplift total

export const SECOND_RUN_TOTAL_FACTOR = 1.05; // 5% uplift on everything

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

  let firstRun = { bnl: 0, nordics: 0, de: 0, total: 0 };
  let secondRun = 0;
  let thirdRun  = 0;

  if (runCount === 1) {
    firstRun = {
      bnl,
      nordics,
      de,
      total: baseTotal
    };
    secondRun = 0;
    thirdRun  = 0;
  } else if (runCount === 2) {
    firstRun = {
      bnl:     Math.round(bnl     * RUN_ONE_FACTOR),
      nordics: Math.round(nordics * RUN_ONE_FACTOR),
      de:      Math.round(de      * RUN_ONE_FACTOR),
      total:   0
    };
    firstRun.total = firstRun.bnl + firstRun.nordics + firstRun.de;
    secondRun = Math.max(0, upliftTotal - firstRun.total);
    thirdRun  = 0;
  } else {
    // 3 runs: Run 1 = 65%, Run 3 = 10%, Run 2 = rest
    firstRun = {
      bnl:     Math.round(bnl     * RUN_ONE_FACTOR),
      nordics: Math.round(nordics * RUN_ONE_FACTOR),
      de:      Math.round(de      * RUN_ONE_FACTOR),
      total:   0
    };
    firstRun.total = firstRun.bnl + firstRun.nordics + firstRun.de;
    thirdRun  = Math.round(upliftTotal * LAST_RUN_FACTOR);
    secondRun = Math.max(0, upliftTotal - firstRun.total - thirdRun);
  }

  return {
    runCount,
    firstRun,
    baseTotal,
    baseRemainder: Math.max(0, baseTotal - firstRun.total),
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
