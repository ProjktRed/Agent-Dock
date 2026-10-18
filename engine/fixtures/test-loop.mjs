import {runNodeLoop} from '../src/node-loop.mjs';

// Own every background loop, including assertion-failure cleanup. Waiting for the
// producer's event avoids both load-dependent polling deadlines and stale live.json.
export function startTestLoop(options, run = runNodeLoop) {
  let stopping = false;
  const events = [], listeners = new Set();
  const loop = run({...options,
    readControl: async () => ({...await options.readControl(), ...(stopping ? {stopAfterSafePoint: true} : {})}),
    onEvent: async event => {
      await options.onEvent(event);
      events.push(event);
      for (const listener of listeners) listener(event);
    },
  });
  // Attach immediately: a failure before the test reaches its await is still owned.
  loop.catch(() => {});
  loop.waitForEvent = async type => {
    const existing = events.find(event => event.type === type);
    if (existing) return existing;
    let listener;
    const event = new Promise(resolve => { listener = value => { if (value.type === type) resolve(value); }; listeners.add(listener); });
    try {
      return await Promise.race([event, loop.then(result => { throw Error(`Loop ended before ${type}: ${JSON.stringify(result)}`); })]);
    } finally { listeners.delete(listener); }
  };
  loop.stop = async () => { stopping = true; await loop.catch(() => {}); };
  return loop;
}
