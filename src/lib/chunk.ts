/**
 * Max IDs per `.in(...)` filter. PostgREST encodes the filter in the request URL, so very large
 * selections would otherwise exceed URL length limits (HTTP 414).
 */
export const BULK_CHUNK_SIZE = 150

export function chunkArray<T>(items: T[], size = BULK_CHUNK_SIZE): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Runs a Supabase request once per chunk of `ids`, concurrently via `Promise.all`.
 * Returns every result plus the first error encountered (if any).
 */
export async function runChunked<T extends { error: { message: string } | null }>(
  ids: string[],
  run: (chunk: string[]) => PromiseLike<T>,
  size = BULK_CHUNK_SIZE
): Promise<{ error: { message: string } | null; results: T[] }> {
  const results = await Promise.all(chunkArray(ids, size).map((chunk) => run(chunk)))
  const failed = results.find((r) => r.error)
  return { error: failed?.error ?? null, results }
}
