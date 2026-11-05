// Which code to start. state is patches/current.json: the patch to run, the one before it, and whether it has proved itself.
// Plain JS outside the bundle: patches replace the bundle, so this part must keep working when one is broken.

export function rollback(state) {
  return { version: state.previous ?? null, previous: null, trial: false, tried: false, bad: [...(state.bad ?? []), state.version] };
}

// A patch on trial gets one start. If the window never came up, the next start goes back to the code before it.
export function chooseBoot(state) {
  if (!state?.version) return { run: null, state: null };
  if (!state.trial) return { run: state.version, state: null };
  if (state.tried) {
    const back = rollback(state);
    return { run: back.version, state: back };
  }
  return { run: state.version, state: { ...state, tried: true } };
}
