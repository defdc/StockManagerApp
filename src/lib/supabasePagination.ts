interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
}

export interface FetchAllRowsOptions {
  pageSize?: number
  signal?: AbortSignal
  shouldCancel?: () => boolean
}

type PageFetcher<T> = (
  from: number,
  to: number,
  signal?: AbortSignal
) => PromiseLike<PageResult<T>>

export const DEFAULT_FETCH_PAGE_SIZE = 1000

export function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') {
    return true
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    const msg = err.message.toLowerCase()
    if (msg.includes('abort') || msg.includes('signal is aborted')) return true
  }
  if (typeof err === 'object' && 'message' in err && typeof (err as { message?: unknown }).message === 'string') {
    const msg = ((err as { message: string }).message).toLowerCase()
    if (msg.includes('abort') || msg.includes('signal is aborted')) return true
  }
  return false
}

export async function fetchAllRows<T>(
  fetchPage: PageFetcher<T>,
  pageSizeOrOptions: number | FetchAllRowsOptions = DEFAULT_FETCH_PAGE_SIZE,
  extraOptions?: Omit<FetchAllRowsOptions, 'pageSize'>
): Promise<T[]> {
  const pageSize =
    typeof pageSizeOrOptions === 'number'
      ? pageSizeOrOptions
      : (pageSizeOrOptions.pageSize ?? DEFAULT_FETCH_PAGE_SIZE)
  const signal =
    typeof pageSizeOrOptions === 'number'
      ? extraOptions?.signal
      : pageSizeOrOptions.signal
  const shouldCancel =
    typeof pageSizeOrOptions === 'number'
      ? extraOptions?.shouldCancel
      : pageSizeOrOptions.shouldCancel

  const rows: T[] = []
  let from = 0

  while (true) {
    if (signal?.aborted || shouldCancel?.()) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const { data, error } = await fetchPage(from, from + pageSize - 1, signal)

    if (signal?.aborted || shouldCancel?.()) {
      throw new DOMException('Aborted', 'AbortError')
    }

    if (error) {
      if (isAbortError(error)) {
        throw new DOMException(error.message || 'Aborted', 'AbortError')
      }
      throw new Error(error.message)
    }
    if (!data || data.length === 0) break

    rows.push(...data)

    if (data.length < pageSize) break
    from += pageSize
  }

  return rows
}
