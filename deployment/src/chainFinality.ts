export async function waitForCommittedTransaction<
  T extends { status?: string; blockNumber?: bigint },
>(
  client: { getTransaction(txHash: string): Promise<T | null | undefined> },
  txHash: string,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    operation: string;
  },
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const transaction = await client.getTransaction(txHash);
    if (transaction?.status === "committed") return transaction;
    if (transaction?.status === "rejected") {
      throw new Error(`${options.operation} transaction ${txHash} was rejected`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `${options.operation} transaction ${txHash} did not commit within ${String(timeoutMs)} milliseconds`,
  );
}
