interface StatCardProps {
  label: string
  value: string
  subtext?: string
}

export default function StatCard({ label, value, subtext }: StatCardProps) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
      {subtext && <p className="mt-1 text-xs text-gray-400">{subtext}</p>}
    </div>
  )
}
