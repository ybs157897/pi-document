/** Only test harnesses supply this callback; it is never accepted from client requests or environment variables. */
export type FaultHook = (point: string) => Promise<void>;
