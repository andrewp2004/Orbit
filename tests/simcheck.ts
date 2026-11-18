import { World } from '../shared/sim';
import { botBrain, BOT_NAMES } from '../shared/ai';
import { DEFAULT_SETTINGS, SIM_DT } from '../shared/constants';
for (const diff of ['easy','normal','hard'] as const) {
  const w = new World({ ...DEFAULT_SETTINGS }, 42);
  w.brain = botBrain;
  for (let i = 0; i < 11; i++) w.addPlayer({ name: BOT_NAMES[i], isBot: true, difficulty: diff });
  w.start();
  const causes: Record<string, number> = {};
  const deathTimes: number[] = [];
  let steps = 0;
  while (w.phase !== 'ended' && steps < 60 * 600) { w.step(SIM_DT); steps++;
    for (const e of w.drainEvents()) if (e.t === 'death') { causes[e.cause] = (causes[e.cause]||0)+1; deathTimes.push(Math.round(w.time)); } }
  const r = w.results();
  console.log(diff, 'duration', w.time.toFixed(0), 's', causes, 'deaths at', deathTimes.join(','), 'winner', r[0].name, r[0].score, 'kills total', r.reduce((a,b)=>a+b.kills,0), 'maxMass', Math.max(...r.map(x=>x.peakMass)));
}
