import type { ReactNode } from 'react'

export interface Column<T> {
  header: string
  render: (row: T) => ReactNode
  className?: string
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  keyField: (row: T) => string
  emptyMessage?: string
}

export default function DataTable<T>({
  columns,
  data,
  keyField,
  emptyMessage = 'No data found.',
}: DataTableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            {columns.map((col) => (
              <th
                key={col.header}
                className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-600"
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-gray-400">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr key={keyField(row)} className="hover:bg-gray-50">
                {columns.map((col) => (
                  <td key={col.header} className={`whitespace-nowrap px-3 py-2 ${col.className ?? ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
