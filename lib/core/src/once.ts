// One report per fault. A family draws every frame, and a bad declaration is bad on every frame, so
// a fault reported from a draw fills the console for as long as the session runs.

/**
 * Make a reporter. The reporter sends a message to `emit` the first time it gets that `key`, and
 * drops the message every time after.
 *
 * The key states which fault this is. Use the declared name, or the path the fault is about. One bad
 * path then gives one line, and a second bad path gives its own line.
 */
export function sayOnce(emit: (message: string) => void): (key: string, message: string) => void {
  const said = new Set<string>();
  return (key, message) => {
    if (said.has(key)) return;
    said.add(key);
    emit(message);
  };
}
