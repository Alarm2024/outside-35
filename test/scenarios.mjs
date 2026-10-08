// Six test plans, used by the model check (Node) and the browser bench: the
// app's own lists under different weather, seasons and times of day.
import { conditionWords } from '../src/lib/plan.js';

const F = (minTemp, maxTemp, maxPop, maxUv, maxWind, thunder = false) => ({ minTemp, maxTemp, maxPop, maxUv, maxWind, thunder });

export const SCENARIOS = [
  { activity: 'walk', facts: F(14, 17, 10, 2, 12), seasonName: 'autumn', part: 'afternoon' },
  { activity: 'hike', facts: F(3, 8, 70, 1, 35), seasonName: 'winter', part: 'morning' },
  { activity: 'garden', facts: F(22, 29, 0, 8, 8), seasonName: 'summer', part: 'midday' },
  { activity: 'walk', facts: null, seasonName: 'unknown', part: 'unknown' },
  { activity: 'hike', facts: null, seasonName: 'spring', part: 'morning' },
  { activity: 'walk', facts: F(-3, 2, 10, 1, 15), seasonName: 'winter', part: 'afternoon' },
];

/** The plan the app would build for a scenario. */
export function scenarioPlan(s) {
  return { activity: s.activity, words: conditionWords(s.facts), seasonName: s.seasonName, part: s.part };
}
