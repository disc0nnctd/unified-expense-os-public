let lastMs = 0;
let counter = 0;

// Hybrid logical clock: monotonic even when Date.now() repeats a millisecond
// or the wall clock steps backwards. Format {ms}-{counter}-{node} matches the
// backend's numeric-tuple comparison.
export function nextHlc(nodeId: string): string {
  const now = Date.now();
  if (now <= lastMs) {
    counter += 1;
  } else {
    lastMs = now;
    counter = 0;
  }
  return `${lastMs}-${counter}-${nodeId}`;
}
