interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
}

type PageFetcher<T> = (from: number, to: number) => PromiseLike<PageResult<T>>

export async function fetchAllRows<T>(fetchPage: PageFetcher<T>, pageSize = 1000): Promise<T[]> {
  const rows: T[] = []
  let from = 0

  while (true) {
    const { data, error } = await fetchPage(from, from + pageSize - 1)

    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break

    rows.push(...data)

    if (data.length < pageSize) break
    from += pageSize
  }

  return rows
}
