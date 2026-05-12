export type RunMarketVolumes = {
  bnl: number;
  nordics: number;
  de: number;
};

export type RunSplitPlan = {
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
};

export const RUN_ONE_FACTORS = {
  bnl: 0.5,
  nordics: 1,
  de: 0.7,
} as const;

export const SECOND_RUN_TOTAL_FACTOR = 1.1;

function cleanPortions(value: number): number {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

export function calculateRunSplit(volumes: RunMarketVolumes): RunSplitPlan {
  const bnl = cleanPortions(volumes.bnl);
  const nordics = cleanPortions(volumes.nordics);
  const de = cleanPortions(volumes.de);
  const baseTotal = bnl + nordics + de;

  const firstRun = {
    bnl: Math.round(bnl * RUN_ONE_FACTORS.bnl),
    nordics: Math.round(nordics * RUN_ONE_FACTORS.nordics),
    de: Math.round(de * RUN_ONE_FACTORS.de),
  };
  const firstTotal = firstRun.bnl + firstRun.nordics + firstRun.de;
  const upliftTotal = Math.round(baseTotal * SECOND_RUN_TOTAL_FACTOR);

  return {
    firstRun: {
      ...firstRun,
      total: firstTotal,
    },
    baseTotal,
    baseRemainder: Math.max(0, baseTotal - firstTotal),
    upliftTotal,
    upliftPortions: Math.max(0, upliftTotal - baseTotal),
    secondRun: Math.max(0, upliftTotal - firstTotal),
  };
}

export function runSplitForRecipeLike(recipe: {
  bnl?: number;
  nordics?: number;
  de?: number;
  verdenVolume?: { BENL?: number; DKSE?: number; DE?: number };
}): RunSplitPlan {
  return calculateRunSplit({
    bnl: recipe.bnl ?? recipe.verdenVolume?.BENL ?? 0,
    nordics: recipe.nordics ?? recipe.verdenVolume?.DKSE ?? 0,
    de: recipe.de ?? recipe.verdenVolume?.DE ?? 0,
  });
}
