export function remainingAckBudget(
  requestStarted: number,
  originalDeadline: number,
  knownDuplicate: boolean,
  now: number,
): number {
  const requestDeadline = requestStarted + 2500;
  return (knownDuplicate ? requestDeadline : Math.min(requestDeadline, originalDeadline)) - now;
}
