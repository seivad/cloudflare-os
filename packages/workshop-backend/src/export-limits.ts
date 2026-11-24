/** Wall-clock budget covering generation and delivery of an export. */
export const MAX_EXPORT_DURATION_MS = 30_000;

/** Largest export the Workshop will stream. */
export const MAX_EXPORT_BYTES = 100 * 1024 * 1024;

/**
 * Largest gadget data an admin's copy reads (OverseerImpl.readGadgetStorage()): the storage as
 * measured, and data.json as UTF-8. The reader hands data.json to the Overseer in one RPC message,
 * which Workers caps at 32 MiB, and the copy is held several times over while it is encoded and
 * zipped, inside one isolate's 128 MB; a quarter of the RPC cap leaves room for both.
 */
export const MAX_EXPORT_DATA_BYTES = 16 * 1024 * 1024;

/** A size in bytes as a limit's message names it: bytes below a megabyte, megabytes above. */
export function describeBytes(bytes: number): string {
  const megabyte = 1024 * 1024;
  return bytes < megabyte ? `${bytes} bytes` : `${Number((bytes / megabyte).toFixed(1))} MB`;
}

/** A deadline shared by export setup and stream delivery. */
export type ExportDeadline = ReturnType<typeof createExportDeadline>;

/** Creates a rejectable wall-clock deadline for an export operation. */
export function createExportDeadline(message: string, durationMs = MAX_EXPORT_DURATION_MS) {
  const expired = Promise.withResolvers<never>();
  const error = new Error(message);
  let hasExpired = false;
  const timer = setTimeout(() => {
    hasExpired = true;
    expired.reject(error);
  }, durationMs);
  expired.promise.catch(() => {});

  return {
    error,
    /** Whether the deadline has passed: work that has not started yet need not. */
    get expired(): boolean {
      return hasExpired;
    },
    race<T>(work: Promise<T>): Promise<T> {
      return Promise.race([work, expired.promise]);
    },
    clear(): void {
      clearTimeout(timer);
    },
    onExpire(callback: (reason: Error) => Promise<void>): void {
      void expired.promise.catch(callback).catch(() => {});
    },
  };
}

/** Enforces export size and duration while releasing owned resources on settlement. */
export function limitExportStream(
  source: ReadableStream<Uint8Array>,
  deadline: ExportDeadline,
  release: () => Promise<void> = async () => {},
  maxBytes = MAX_EXPORT_BYTES,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let total = 0;
  let settlePromise: Promise<void> | undefined;
  const settle = (cancelSource: boolean, reason?: unknown) => {
    if (!settlePromise) {
      deadline.clear();
      settlePromise = (async () => {
        await release();
        // Cancellation is advisory. A hostile Gadget stream must not keep the
        // export or its owned browser alive by returning a promise that never settles.
        if (cancelSource) void reader.cancel(reason).catch(() => {});
      })();
    }
    return settlePromise;
  };

  deadline.onExpire(reason => settle(true, reason));

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await deadline.race(reader.read());
        if (chunk.done) {
          await settle(false);
          controller.close();
          return;
        }
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          throw new Error(`Gadget exports may not exceed ${maxBytes} bytes.`);
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        const cleanup = settle(true, error);
        if (error !== deadline.error) await cleanup;
        throw error;
      }
    },
    async cancel(reason) {
      await settle(true, reason);
    },
  });
}
