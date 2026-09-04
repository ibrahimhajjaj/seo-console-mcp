// Every surface that fans out over a list needs the same bounded pool, and a
// second copy of it is a second place for the ordering guarantee to drift.
export async function mapWithConcurrency<T, R>(values: T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker));
  return results;
}
